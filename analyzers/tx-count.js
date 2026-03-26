/**
 * 分析器: 区块交易数量分析 (TxCount)
 *
 * 功能: 统计指定区块范围内每个区块的交易数量
 * 输出: 交易数量统计、分布、趋势图
 *
 * 绘图效果:
 * - ASCII: 折线图 + 柱状分布图
 * - HTML: Chart.js 折线图 + 柱状图
 *
 * 独立运行: node analyzers/tx-count.js --start 824190 --end 824200
 * 框架调用: 通过 framework.js 组合调用，数据由框架统一绘图
 */

const { RPCClient } = require('../lib/rpc');
const { analyze, histogram } = require('../lib/stats');
const { Reporter } = require('../lib/reporter');
const { LineChart, BarChart, HTMLChartBuilder } = require('../lib/charts');

// ============ 分析器信息 ============
const ANALYZER_INFO = {
    id: 'tx-count',
    name: '区块交易数量分析',
    description: '分析区块范围内的交易数量分布和趋势',
    icon: '📦',
    version: '2.0.0',
    options: [
        { name: 'start', alias: 's', type: 'number', description: '起始区块高度', default: null },
        { name: 'end', alias: 'e', type: 'number', description: '结束区块高度', default: null },
        { name: 'html', type: 'boolean', description: '生成 HTML 报告', default: false },
        { name: 'chart', type: 'boolean', description: '显示 ASCII 图表', default: false }
    ]
};

// ============ 核心分析逻辑 ============
async function analyzeTxCount(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    // 确定区块范围
    const latestHeight = await rpc.getBlockCount();
    const startHeight = config.start || Math.max(1, latestHeight - 999);
    const endHeight = config.end || latestHeight;

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} - ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);

    // 获取数据
    const blockData = [];
    const batchSize = 100;
    const totalBlocks = endHeight - startHeight + 1;

    for (let h = startHeight; h <= endHeight; h += batchSize) {
        const batchEnd = Math.min(h + batchSize - 1, endHeight);
        const promises = [];

        for (let height = h; height <= batchEnd; height++) {
            promises.push(
                rpc.getBlock(height, 1)
                    .then(block => ({
                        height,
                        numTx: block.nTx || (block.tx ? block.tx.length : 0),
                        time: block.time,
                        hash: block.hash
                    }))
                    .catch(err => {
                        reporter.error(`获取区块 ${height} 失败:`, err.message);
                        return null;
                    })
            );
        }

        const results = await Promise.all(promises);
        blockData.push(...results.filter(r => r !== null));

        const progress = ((batchEnd - startHeight + 1) / totalBlocks * 100).toFixed(1);
        reporter.log(`\r  进度: ${progress}% (${batchEnd - startHeight + 1}/${totalBlocks})`);
    }

    reporter.log('');

    if (blockData.length === 0) {
        throw new Error('未能获取任何区块数据');
    }

    // 按高度排序
    blockData.sort((a, b) => a.height - b.height);

    // 统计分析
    const txCounts = blockData.map(b => b.numTx);
    const stats = analyze(txCounts);

    // 输出统计结果
    reporter.section('统计结果');
    reporter.stats(stats);

    // 找出极值区块
    const maxBlock = blockData.reduce((max, b) => b.numTx > max.numTx ? b : max);
    const minBlock = blockData.reduce((min, b) => b.numTx < min.numTx ? b : min);

    reporter.section('极值区块');
    reporter.kv('交易最多', `区块 #${maxBlock.height}: ${maxBlock.numTx} 笔`);
    reporter.kv('交易最少', `区块 #${minBlock.height}: ${minBlock.numTx} 笔`);

    // 分布统计
    const ranges = [
        { min: 0, max: 100, label: '0-100' },
        { min: 101, max: 500, label: '101-500' },
        { min: 501, max: 1000, label: '501-1000' },
        { min: 1001, max: 2000, label: '1001-2000' },
        { min: 2001, max: 5000, label: '2001-5000' },
        { min: 5001, max: 10000, label: '5001-10000' },
        { min: 10001, max: Infinity, label: '>10000' }
    ];
    const dist = histogram(txCounts, null, ranges).filter(d => d.count > 0);

    reporter.section('交易数量分布');
    new BarChart(60, 10).draw(dist.map(d => ({ label: d.label, value: d.count })));

    // ============ 绘图数据准备 ============
    const chartData = {
        trend: {
            labels: blockData.map(b => `#${b.height}`),
            values: blockData.map(b => b.numTx)
        },
        distribution: dist.map(d => ({ label: d.label, count: d.count })),
        stats,
        extremes: { max: maxBlock, min: minBlock }
    };

    // ============ ASCII 图表 ============
    if (config.chart) {
        reporter.section('交易数量趋势图（采样）');
        const sampleSize = Math.min(blockData.length, 50);
        const step = Math.ceil(blockData.length / sampleSize);
        const sampleData = blockData.filter((_, i) => i % step === 0);

        new LineChart(80, 12)
            .draw(
                sampleData.map(b => b.numTx),
                sampleData.map(b => `#${b.height}`),
                {
                    avgLine: stats.mean,
                    pointChar: '●'
                }
            )
            .print('', `平均值: ${stats.mean.toFixed(2)}`);
    }

    // ============ 构建返回数据 ============
    const result = {
        info: ANALYZER_INFO,
        config: { startHeight, endHeight },
        data: {
            blockData,
            txCounts,
            stats,
            distribution: dist,
            extremes: { max: maxBlock, min: minBlock },
            chartData
        }
    };

    // ============ HTML 报告 ============
    if (config.html) {
        const builder = new HTMLChartBuilder();

        builder.addLineChart(
            chartData.trend.labels,
            chartData.trend.values,
            {
                title: '交易数量趋势',
                height: 100,
                label: '交易数量',
                color: 'rgb(102, 126, 234)',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                xLabel: '区块高度',
                yLabel: '交易数量'
            }
        );

        builder.addBarChart(
            chartData.distribution.map(d => d.label),
            chartData.distribution.map(d => d.count),
            {
                title: '交易数量分布',
                height: 80,
                xLabel: '交易数量范围',
                yLabel: '区块数量',
                colors: dist.map(d => {
                    const avg = (d.min + (d.max === Infinity ? 15000 : d.max)) / 2;
                    if (avg < 500) return 'rgba(39, 174, 96, 0.7)';
                    if (avg < 2000) return 'rgba(52, 152, 219, 0.7)';
                    return 'rgba(231, 76, 60, 0.7)';
                })
            }
        );

        const htmlPath = builder
            .setTitle(`${ANALYZER_INFO.name}报告 (${startHeight}-${endHeight})`)
            .save(`tx-count_${startHeight}_${endHeight}_${Date.now()}.html`, config.outputDir || './reports');

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
    console.log(`  node ${__filename} --start 824190 --end 824200 --html`);
    console.log(`  node ${__filename} --html --chart`);
}

// ============ 导出和独立运行 ============
module.exports = {
    info: ANALYZER_INFO,
    analyze: analyzeTxCount
};

// 独立运行检测
if (require.main === module) {
    const config = parseArgs();
    analyzeTxCount(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
