/**
 * 分析器: 交易祖先深度分析 (AncestorDepth)
 *
 * 功能: 分析区块内交易的祖先引用深度（交易输入追溯到 coinbase 的最长链长度）
 * 输出: 全局最大/平均祖先深度 + 深度分布
 *
 * 独立运行: node analyzers/ancestor-depth.js --start 824190 --end 824195
 */

const { RPCClient } = require('../lib/rpc');
const { Reporter } = require('../lib/reporter');
const { LineChart, BarChart, HTMLChartBuilder } = require('../lib/charts');
// const pLimit = require('p-limit'); // ❌ 已移除并发

// ============ 分析器信息 ============
const ANALYZER_INFO = {
    id: 'ancestor-depth',
    name: '交易祖先深度分析',
    description: '分析区块内交易的祖先引用链深度（轻量版）',
    icon: '🌳',
    version: '3.1.0',
    options: [
        { name: 'start', alias: 's', type: 'number', default: null },
        { name: 'end', alias: 'e', type: 'number', default: null },
        { name: 'html', type: 'boolean', default: false },
        { name: 'chart', type: 'boolean', default: false },
        { name: 'verbose', alias: 'v', type: 'boolean', default: false },
        { name: 'concurrency', alias: 'c', type: 'number', default: 1 }, // 已无效，仅保留参数
        { name: 'top', alias: 'n', type: 'number', default: 10 }
    ]
};

// ============ 核心：区块内深度计算（改：直接统计，不返回数组） ============
function calculateInBlockStats(txs) {
    const depthMap = new Map();

    let localMax = 0;
    let sum = 0;
    let count = 0;
    const histogram = {};

    for (const tx of txs) {
        if (!tx || !tx.txid) continue;

        let depth;

        if (tx.vin?.[0]?.coinbase) {
            depth = 0;
        } else {
            let maxParentDepth = -1;

            for (const input of tx.vin || []) {
                if (input.txid && depthMap.has(input.txid)) {
                    maxParentDepth = Math.max(maxParentDepth, depthMap.get(input.txid));
                }
            }

            depth = maxParentDepth >= 0 ? maxParentDepth + 1 : 0;
        }

        depthMap.set(tx.txid, depth);

        // ✅ 直接统计（无 depths 数组）
        sum += depth;
        count++;

        if (depth > localMax) {
            localMax = depth;
        }

        histogram[depth] = (histogram[depth] || 0) + 1;
    }
    
    depthMap.clear();
    return { max: localMax, sum, count, histogram };
}

// ============ 单区块分析（仅调用统计函数） ============
async function analyzeBlock(blockHeight, rpc, reporter) {
    try {
        const block = await rpc.getBlock(blockHeight, 2);

        if (!block.tx || block.tx.length === 0) {
            return null;
        }

        return calculateInBlockStats(block.tx);

    } catch (err) {
        reporter.error(`区块 ${blockHeight} 失败:`, err.message);
        return null;
    }
}

// ============ 主分析逻辑（改：串行流式） ============
async function analyzeAncestorDepth(config = {}) {
    const rpc = new RPCClient({ ...config.rpc, cache: false });
    const reporter = new Reporter({ silent: config.silent });

    const latestHeight = await rpc.getBlockCount();
    const startHeight = config.start || Math.max(1, latestHeight - 9);
    const endHeight = config.end || latestHeight;

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} - ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);
    reporter.log('');

    const topN = config.top || 10;
    let globalSum = 0;
    let globalCount = 0;
    const globalHistogram = {};
    const topBlocks = []; // { height, max }

    // ✅ 串行处理（关键修复）
    for (let h = startHeight; h <= endHeight; h++) {
        reporter.log(`分析区块 ${h}...`);
        const res = await analyzeBlock(h, rpc, reporter);

        if (!res) continue;

        topBlocks.push({ height: h, max: res.max });
        globalSum += res.sum;
        globalCount += res.count;

        for (const [depth, c] of Object.entries(res.histogram)) {
            globalHistogram[depth] = (globalHistogram[depth] || 0) + c;
        }
    }

    topBlocks.sort((a, b) => b.max - a.max);

    const avgDepth = globalCount > 0 ? globalSum / globalCount : 0;

    const globalMax = topBlocks.length > 0 ? topBlocks[0].max : 0;
    const globalMaxHeight = topBlocks.length > 0 ? topBlocks[0].height : null;

    // ===== 输出 =====
    reporter.section('整体统计');
    reporter.log(`【最大深度 Top ${topN}】`);
    topBlocks.slice(0, topN).forEach((b, i) => {
        reporter.kv(`  #${String(i + 1).padStart(2, '0')} 区块 ${b.height}`, b.max);
    });

    reporter.log('\n【平均深度统计】');
    reporter.kv('平均值', avgDepth.toFixed(2));

    // ===== 深度分布 =====
    reporter.section('深度分布');

    const distData = Object.entries(globalHistogram)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([depth, count]) => ({ label: `深度 ${depth}`, value: count }));

    new BarChart(60, 12).draw(distData.slice(0, 20));

    // ===== 图表数据 =====
    const chartData = {
        distribution: distData,
        avgDepth,
        maxDepth: globalMax,
        totalTransactions: globalCount
    };

    if (config.chart) {
        reporter.section('深度分布图');
        new LineChart(80, 10)
            .draw(
                distData.map(d => d.value),
                distData.map(d => d.label)
            )
            .print('', `平均值: ${avgDepth.toFixed(2)}`);
    }

    const result = {
        info: ANALYZER_INFO,
        config: { startHeight, endHeight },
        data: {
            maxDepth: globalMax,
            maxDepthHeight: globalMaxHeight,
            topBlocks: topBlocks.slice(0, topN),
            avgDepth,
            depthDistribution: distData,
            totalTransactions: globalCount
        }
    };

    if (config.html) {
        const builder = new HTMLChartBuilder();

        builder.addBarChart(
            distData.map(d => d.label),
            distData.map(d => d.value),
            {
                title: '祖先深度分布',
                height: 100
            }
        );

        const htmlPath = builder
            .setTitle(`${ANALYZER_INFO.name}报告 (${startHeight}-${endHeight})`)
            .save(`ancestor-depth_${startHeight}_${endHeight}_${Date.now()}.html`, config.outputDir || './reports');

        reporter.log(`\n📄 HTML 报告已保存: ${htmlPath}`);
        result.htmlPath = htmlPath;
    }

    return result;
}

// ============ 参数解析（保持不变） ============
function parseArgs() {
    const args = process.argv.slice(2);
    const config = { rpc: {} };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--start':
            case '-s':
                config.start = parseInt(args[++i]);
                break;
            case '--end':
            case '-e':
                config.end = parseInt(args[++i]);
                break;
            case '--html':
                config.html = true;
                break;
            case '--chart':
                config.chart = true;
                break;
            case '--verbose':
            case '-v':
                config.verbose = true;
                break;
            case '--silent':
                config.silent = true;
                break;
            case '--concurrency':
            case '-c':
                config.concurrency = parseInt(args[++i]);
                break;
            case '--top':
            case '-n':
                config.top = parseInt(args[++i]);
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
        }
    }

    return config;
}

module.exports = {
    info: ANALYZER_INFO,
    analyze: analyzeAncestorDepth
};

if (require.main === module) {
    const config = parseArgs();
    analyzeAncestorDepth(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
