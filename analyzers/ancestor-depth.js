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
        { name: 'verbose', alias: 'v', type: 'boolean', description: '显示详细进度', default: false }
    ]
};

// ============ 核心分析逻辑 ============
function calculateInBlockDepths(txs) {
    // 构建区块内交易映射
    const txMap = new Map();
    for (const tx of txs) {
        if (tx.txid) {
            txMap.set(tx.txid, tx);
        }
    }

    // 记忆化 DFS：深度 = 引用的区块内层级数
    const depthCache = new Map();

    function getDepth(txid) {
        if (depthCache.has(txid)) return depthCache.get(txid);

        const tx = txMap.get(txid);
        if (!tx || !tx.vin || tx.vin.length === 0) {
            depthCache.set(txid, 0);
            return 0;
        }

        // coinbase 深度为 0
        if (tx.vin[0].coinbase) {
            depthCache.set(txid, 0);
            return 0;
        }

        // 深度 = 1 + 区块内父交易的最大深度
        let maxParentDepth = 0;
        for (const input of tx.vin) {
            if (input.txid && txMap.has(input.txid)) {
                maxParentDepth = Math.max(maxParentDepth, getDepth(input.txid));
            }
        }

        const depth = maxParentDepth + (maxParentDepth >= 0 ? 1 : 0);
        depthCache.set(txid, depth);
        return depth;
    }

    // 计算所有交易的深度
    const results = [];
    for (const tx of txs) {
        if (tx.txid) {
            const depth = tx.vin?.[0]?.coinbase ? 0 : getDepth(tx.txid);
            results.push({ txid: tx.txid, depth, isCoinbase: !!tx.vin?.[0]?.coinbase });
        }
    }

    return results;
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
                depths: [],
                totalTx: 0,
                regularTx: 0,
                time: block.time
            };
        }

        // 使用高效的记忆化算法计算所有交易深度
        const depths = calculateInBlockDepths(block.tx);

        const depthValues = depths.map(d => d.depth);
        const stats = depthValues.length > 0 ? analyze(depthValues) : { mean: 0, median: 0, max: 0, min: 0 };

        // 找出最大深度的交易
        let maxDepthInBlock = 0;
        let maxDepthTxId = null;
        for (const d of depths) {
            if (d.depth > maxDepthInBlock) {
                maxDepthInBlock = d.depth;
                maxDepthTxId = d.txid;
            }
        }

        return {
            height: blockHeight,
            maxDepth: maxDepthInBlock,
            maxDepthTxId,
            avgDepth: stats.mean,
            medianDepth: stats.median,
            minDepth: stats.min,
            depths,
            totalTx: block.tx.length,
            regularTx: block.tx.length,
            time: block.time
        };

    } catch (err) {
        reporter.error(`分析区块 ${blockHeight} 失败:`, err.message);
        return { height: blockHeight, error: err.message };
    }
}

async function analyzeAncestorDepth(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    // 确定区块范围
    const latestHeight = await rpc.getBlockCount();
    const startHeight = config.start || Math.max(1, latestHeight - 9);
    const endHeight = config.end || latestHeight;

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} - ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);
    reporter.log('');

    const blockResults = [];

    for (let h = startHeight; h <= endHeight; h++) {
        reporter.log(`分析区块 ${h}...`);

        const result = await analyzeBlock(h, rpc, reporter, config.verbose);

        if (!result.error) {
            blockResults.push(result);
            reporter.log(`  最大深度: ${result.maxDepth}, ` +
                `交易: ${result.totalTx}, ` +
                `平均深度: ${result.avgDepth.toFixed(1)}`);
        }
    }

    if (blockResults.length === 0) {
        throw new Error('没有有效的分析结果');
    }

    // 整体统计
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

    // 深度分布
    const allDepths = blockResults.flatMap(b => b.depths?.map(d => d.depth) || []);
    const depthDist = {};
    for (const d of allDepths) {
        depthDist[d] = (depthDist[d] || 0) + 1;
    }

    reporter.section('深度分布');
    const distData = Object.entries(depthDist)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([depth, count]) => ({ label: `深度 ${depth}`, value: count }));

    new BarChart(60, 12).draw(distData.slice(0, 20));

    // ============ 绘图数据准备 ============
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
        totalTransactions: allDepths.length
    };

    // ============ ASCII 图表 ============
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

    // ============ 构建返回数据 ============
    const result = {
        info: ANALYZER_INFO,
        config: { startHeight, endHeight },
        data: {
            blockResults,
            globalStats,
            depthDistribution: distData,
            totalTransactions: allDepths.length,
            chartData
        }
    };

    // ============ HTML 报告 ============
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
                    const hue = 120 + (i * 5); // 从绿色渐变
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

// ============ 命令行参数解析 ============
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
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
        }
    }

    return config;
}

function printUsage() {
    console.log(`用法: node ${__filename} [选项]`);
    console.log('');
    console.log('选项:');
    ANALYZER_INFO.options.forEach(opt => {
        const alias = opt.alias ? `-${opt.alias}, ` : '    ';
        const defaultVal = opt.default !== undefined ? ` (默认: ${opt.default})` : '';
        console.log(`  ${alias}--${opt.name.padEnd(12)} ${opt.description}${defaultVal}`);
    });
    console.log('');
    console.log('示例:');
    console.log(`  node ${__filename} --start 824190 --end 824195 --html`);
    console.log(`  node ${__filename} --html --chart`);
}

// ============ 导出和独立运行 ============
module.exports = {
    info: ANALYZER_INFO,
    analyze: analyzeAncestorDepth
};

// 独立运行检测
if (require.main === module) {
    const config = parseArgs();
    analyzeAncestorDepth(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
