/**
 * 分析器: 交易祖先深度分析 (AncestorDepth)
 *
 * 功能: 分析区块内交易的祖先引用深度（交易输入追溯到 coinbase 的最长链长度）
 * 输出: 各区块最大/平均/中位祖先深度，深度分布
 *
 * 绘图效果:
 * - ASCII: 折线图显示各区块深度趋势
 * - HTML: Chart.js 折线图 + 深度分布柱状图
 *
 * 独立运行: node analyzers/ancestor-depth.js --start 824190 --end 824195
 * 框架调用: 通过 framework.js 组合调用
 */

const { RPCClient } = require('../lib/rpc');
const { analyze } = require('../lib/stats');
const { Reporter } = require('../lib/reporter');
const { LineChart, BarChart, HTMLChartBuilder } = require('../lib/charts');
const pLimit = require('p-limit'); // ⭐ 新增

// ============ 分析器信息 ============
const ANALYZER_INFO = {
    id: 'ancestor-depth',
    name: '交易祖先深度分析',
    description: '分析区块内交易的祖先引用链深度',
    icon: '🌳',
    version: '2.0.0',
    options: [
        { name: 'start', alias: 's', type: 'number', description: '起始区块高度', default: null },
        { name: 'end', alias: 'e', type: 'number', description: '结束区块高度', default: null },
        { name: 'html', type: 'boolean', description: '生成 HTML 报告', default: false },
        { name: 'chart', type: 'boolean', description: '显示 ASCII 图表', default: false },
        { name: 'verbose', alias: 'v', type: 'boolean', description: '显示详细进度', default: false },
        { name: 'concurrency', alias: 'c', type: 'number', description: '并发数', default: 6 } // ⭐ 新增
    ]
};

// ============ 核心分析逻辑（改：DFS → DP） ============
function calculateInBlockDepths(txs) {
    const txMap = new Map();
    const depthMap = new Map();

    for (const tx of txs) {
        if (tx.txid) {
            txMap.set(tx.txid, tx);
        }
    }

    // 按顺序计算（依赖 Bitcoin RPC 已拓扑排序）
    for (const tx of txs) {
        if (!tx.txid) continue;

        if (tx.vin?.[0]?.coinbase) {
            depthMap.set(tx.txid, 0);
            continue;
        }

        let maxParentDepth = -1;

        for (const input of tx.vin || []) {
            if (input.txid && depthMap.has(input.txid)) {
                maxParentDepth = Math.max(maxParentDepth, depthMap.get(input.txid));
            }
        }

        const depth = maxParentDepth >= 0 ? maxParentDepth + 1 : 0;
        depthMap.set(tx.txid, depth);
    }

    return txs
        .filter(tx => tx.txid)
        .map(tx => ({
            txid: tx.txid,
            depth: depthMap.get(tx.txid) ?? 0,
            isCoinbase: !!tx.vin?.[0]?.coinbase
        }));
}

async function analyzeBlock(blockHeight, rpc, reporter, verbose = false) {
    try {
        const block = await rpc.getBlock(blockHeight, 2);

        if (!block.tx || block.tx.length === 0) {
            return {
                height: blockHeight,
                maxDepth: 0,
                avgDepth: 0,
                medianDepth: 0,
                totalTx: 0,
                regularTx: 0,
                time: block.time,
                depthHistogram: {} // 只返回深度分布直方图
            };
        }

        const depthList = calculateInBlockDepths(block.tx);

        // 计算统计数据
        const depthValues = depthList.map(d => d.depth);
        const stats = depthValues.length > 0 ? analyze(depthValues) : { mean: 0, median: 0, max: 0, min: 0 };

        // 找出最大深度的交易
        let maxDepthInBlock = 0;
        let maxDepthTxId = null;
        for (const d of depthList) {
            if (d.depth > maxDepthInBlock) {
                maxDepthInBlock = d.depth;
                maxDepthTxId = d.txid;
            }
        }

        // 生成深度直方图（而不是保存完整depths数组）
        const depthHistogram = {};
        for (const d of depthList) {
            depthHistogram[d.depth] = (depthHistogram[d.depth] || 0) + 1;
        }

        return {
            height: blockHeight,
            maxDepth: maxDepthInBlock,
            maxDepthTxId,
            avgDepth: stats.mean,
            medianDepth: stats.median,
            minDepth: stats.min,
            totalTx: block.tx.length,
            regularTx: block.tx.length - 1, // 减去coinbase
            time: block.time,
            depthHistogram // 用直方图替代完整depths数组
        };

    } catch (err) {
        reporter.error(`分析区块 ${blockHeight} 失败:`, err.message);
        return { height: blockHeight, error: err.message };
    }
}

// ============ 主分析逻辑（改：串行 → 限流并发） ============
async function analyzeAncestorDepth(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    const latestHeight = await rpc.getBlockCount();
    const startHeight = config.start || Math.max(1, latestHeight - 9);
    const endHeight = config.end || latestHeight;

    const concurrency = config.concurrency || 6;
    const limit = pLimit(concurrency);

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} - ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);
    reporter.kv('并发数', concurrency);
    reporter.log('');

    const tasks = [];

    for (let h = startHeight; h <= endHeight; h++) {
        tasks.push(
            limit(async () => {
                reporter.log(`分析区块 ${h}...`);
                return analyzeBlock(h, rpc, reporter, config.verbose);
            })
        );
    }

    const results = await Promise.all(tasks);
    const blockResults = results.filter(r => !r.error);

    if (blockResults.length === 0) {
        throw new Error('没有有效的分析结果');
    }

    // ===== 以下保持原样 =====

    const allMaxDepths = blockResults.map(r => r.maxDepth);
    const allAvgDepths = blockResults.map(r => r.avgDepth);
    const globalStats = {
        maxDepth: {
            globalMax: Math.max(...allMaxDepths),
            avg: analyze(allMaxDepths).mean,
            median: analyze(allMaxDepths).median
        },
        avgDepth: {
            mean: analyze(allAvgDepths).mean,
            median: analyze(allAvgDepths).median
        }
    };

    const blockWithMaxDepth = blockResults.find(r => r.maxDepth === globalStats.maxDepth.globalMax);

    reporter.section('整体统计');
    reporter.log('【最大深度统计】');
    reporter.kv('全局最大值', `${globalStats.maxDepth.globalMax} (区块 #${blockWithMaxDepth?.height})`);
    reporter.kv('平均值', globalStats.maxDepth.avg.toFixed(2));
    reporter.kv('中位数', globalStats.maxDepth.median);

    reporter.log('\n【平均深度统计】');
    reporter.kv('平均值', globalStats.avgDepth.mean.toFixed(2));
    reporter.kv('中位数', globalStats.avgDepth.median);

    // ⭐ 改：使用 depthHistogram 替代 depths，避免持有大量数组
    const depthDist = {};
    for (const b of blockResults) {
        for (const [depth, count] of Object.entries(b.depthHistogram || {})) {
            depthDist[depth] = (depthDist[depth] || 0) + count;
        }
    }

    reporter.section('深度分布');
    const distData = Object.entries(depthDist)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([depth, count]) => ({ label: `深度 ${depth}`, value: count }));

    new BarChart(60, 12).draw(distData.slice(0, 20));

    // ===== 后面全部保持原样 =====

    const chartData = {
        maxDepths: {
            labels: blockResults.map(b => `#${b.height}`),
            values: blockResults.map(b => b.maxDepth)
        },
        avgDepths: {
            labels: blockResults.map(b => `#${b.height}`),
            values: blockResults.map(b => b.avgDepth)
        },
        distribution: distData,
        globalStats,
        totalTransactions: Object.values(depthDist).reduce((a, b) => a + b, 0)
    };

    if (config.chart) {
        reporter.section('最大深度趋势');
        new LineChart(80, 10)
            .draw(
                chartData.maxDepths.values,
                chartData.maxDepths.labels,
                {
                    avgLine: globalStats.maxDepth.avg,
                    pointChar: '▲',
                    color: 'green'
                }
            )
            .print('', `平均值: ${globalStats.maxDepth.avg.toFixed(2)}`);

        reporter.section('平均深度趋势');
        new LineChart(80, 10)
            .draw(
                chartData.avgDepths.values,
                chartData.avgDepths.labels,
                {
                    avgLine: globalStats.avgDepth.mean,
                    pointChar: '●',
                    color: 'blue'
                }
            )
            .print('', `平均值: ${globalStats.avgDepth.mean.toFixed(2)}`);
    }

    const result = {
        info: ANALYZER_INFO,
        config: { startHeight, endHeight },
        data: {
            blockResults,
            globalStats,
            depthDistribution: distData,
            totalTransactions: chartData.totalTransactions,
            chartData
        }
    };

    if (config.html) {
        const builder = new HTMLChartBuilder();

        builder.addLineChart(
            chartData.maxDepths.labels,
            chartData.maxDepths.values,
            {
                title: '各区块最大祖先深度',
                height: 100,
                label: '最大深度',
                color: 'rgb(17, 153, 142)',
                backgroundColor: 'rgba(17, 153, 142, 0.1)',
                fill: true,
                pointRadius: 3,
                xLabel: '区块高度',
                yLabel: '最大深度'
            }
        );

        builder.addLineChart(
            chartData.avgDepths.labels,
            chartData.avgDepths.values,
            {
                title: '各区块平均祖先深度',
                height: 100,
                label: '平均深度',
                color: 'rgb(56, 239, 125)',
                backgroundColor: 'rgba(56, 239, 125, 0.1)',
                fill: true,
                pointRadius: 3,
                xLabel: '区块高度',
                yLabel: '平均深度'
            }
        );

        builder.addBarChart(
            distData.slice(0, 30).map(d => d.label),
            distData.slice(0, 30).map(d => d.value),
            {
                title: '祖先深度分布',
                height: 100,
                xLabel: '祖先深度',
                yLabel: '交易数量',
                colors: distData.slice(0, 30).map((d, i) => {
                    const hue = 120 + (i * 5);
                    return `hsla(${hue % 360}, 70%, 50%, 0.7)`;
                })
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

// ============ 命令行参数解析（仅新增 concurrency） ============
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
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
        }
    }

    return config;
}

// ===== 其余完全保持不变 =====

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
