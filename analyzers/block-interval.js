/**
 * 分析器: 出块间隔分析 (BlockInterval)
 *
 * 功能: 分析区块的出块时间间隔和出块速率
 * 输出: 平均出块间隔、速率波动、时间分布、时间轴散点图
 *
 * 与 chain_analyzer.go 等效的绘图效果:
 * - ASCII: 时间轴散点图，带平均线，异常值用 * 标记
 * - HTML: Chart.js 散点图，X轴为时间，带平均线，颜色编码
 *
 * 独立运行: node analyzers/block-interval.js --start 824190 --end 824200
 * 框架调用: framework 接收数据后调用 lib/charts.js 绘图
 */

const { RPCClient } = require('../lib/rpc');
const { analyze, histogram } = require('../lib/stats');
const { Reporter } = require('../lib/reporter');
const { ScatterTimeChart, BarChart, HTMLChartBuilder } = require('../lib/charts');

// ============ 分析器信息 ============
const ANALYZER_INFO = {
    id: 'block-interval',
    name: '出块间隔分析',
    description: '分析区块出块时间间隔和出块速率（时间轴散点图）',
    icon: '⏱️',
    version: '2.0.0',
    options: [
        { name: 'start', alias: 's', type: 'number', description: '起始区块高度', default: null },
        { name: 'end', alias: 'e', type: 'number', description: '结束区块高度', default: null },
        { name: 'html', type: 'boolean', description: '生成 HTML 报告', default: false },
        { name: 'chart', type: 'boolean', description: '显示 ASCII 图表', default: false },
        { name: 'linear', type: 'boolean', description: '使用线性归一化（默认开平方）', default: false }
    ]
};

// ============ 数据标准化 ============

/**
 * 将间隔数据归一化到 0-110 范围（与 chain_analyzer.go 一致）
 * - 0-100: 正常范围
 * - 110: 异常值（0秒或负数间隔）
 */
function normalizeIntervals(intervals, useSqrt = false) {
    // 过滤掉异常值，计算归一化范围
    const validIntervals = intervals.filter(v => v > 0);
    const maxInterval = Math.max(...validIntervals, 1);

    // 变换
    let transformed = validIntervals.map(v => useSqrt ? Math.sqrt(v) : v);
    const maxT = Math.max(...transformed, 1);
    const minT = Math.min(...transformed);
    const rangeT = maxT - minT || 1;

    return {
        normalized: intervals.map(v => {
            if (v <= 0) return 110; // 异常值
            const t = useSqrt ? Math.sqrt(v) : v;
            return ((t - minT) / rangeT) * 100;
        }),
        maxInterval,
        minT,
        maxT,
        useSqrt
    };
}

/**
 * 根据间隔值获取颜色（与 chain_analyzer.go 一致）
 */
function getColor(diff, avgInterval) {
    if (diff <= 0) return '#e74c3c'; // 异常 - 红色
    if (diff < avgInterval * 0.5) return '#27ae60'; // 很快 - 绿色
    if (diff < avgInterval * 0.8) return '#2ecc71'; // 较快
    if (diff < avgInterval * 1.2) return '#3498db'; // 正常 - 蓝色
    if (diff < avgInterval * 2.0) return '#f39c12'; // 较慢 - 橙色
    return '#e74c3c'; // 很慢 - 红色
}

// ============ 核心分析逻辑 ============

async function analyzeBlockInterval(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    // 确定区块范围
    const latestHeight = await rpc.getBlockCount();
    const startHeight = config.start || Math.max(1, latestHeight - 999);
    const endHeight = config.end || latestHeight;

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} - ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);

    // 获取区块时间戳
    const blocks = [];
    const batchSize = 100;
    const totalBlocks = endHeight - startHeight + 1;

    for (let h = startHeight; h <= endHeight; h += batchSize) {
        const batchEnd = Math.min(h + batchSize - 1, endHeight);
        const promises = [];

        for (let height = h; height <= batchEnd; height++) {
            promises.push(
                rpc.getBlockHeader(height)
                    .then(block => ({
                        height,
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
        blocks.push(...results.filter(r => r !== null));

        const progress = ((batchEnd - startHeight + 1) / totalBlocks * 100).toFixed(1);
        reporter.log(`\r  进度: ${progress}% (${batchEnd - startHeight + 1}/${totalBlocks})`);
    }

    reporter.log('');

    if (blocks.length < 2) {
        throw new Error('需要至少2个区块来计算间隔');
    }

    // 按高度排序
    blocks.sort((a, b) => a.height - b.height);

    // 计算间隔
    const intervals = [];
    for (let i = 1; i < blocks.length; i++) {
        const interval = blocks[i].time - blocks[i - 1].time;
        intervals.push({
            fromHeight: blocks[i - 1].height,
            toHeight: blocks[i].height,
            interval: interval,
            timestamp: blocks[i].time
        });
    }

    const intervalValues = intervals.map(i => i.interval);
    const intervalStats = analyze(intervalValues);

    // 时间范围
    const minTime = Math.min(...blocks.map(t => t.time));
    const maxTime = Math.max(...blocks.map(t => t.time));
    const totalDuration = maxTime - minTime;
    const blocksPerSecond = blocks.length / totalDuration;
    const secondsPerBlock = totalDuration / blocks.length;

    // 归一化（与 chain_analyzer.go 一致）
    const useSqrt = config.linear !== true;
    const normalized = normalizeIntervals(intervalValues, useSqrt);

    // 输出统计
    reporter.section('出块间隔统计');
    reporter.stats(intervalStats);

    reporter.section('出块速率');
    reporter.kv('总时长', `${(totalDuration / 60).toFixed(2)} 分钟`);
    reporter.kv('平均间隔', `${secondsPerBlock.toFixed(2)} 秒`);
    reporter.kv('每秒区块数', blocksPerSecond.toFixed(6));
    reporter.kv('每小时区块数', (blocksPerSecond * 3600).toFixed(2));

    // 找出极端间隔
    const maxInterval = intervals.reduce((max, i) => i.interval > max.interval ? i : max);
    const minInterval = intervals.reduce((min, i) => i.interval < min.interval ? i : min);

    reporter.section('极端间隔');
    reporter.kv('最大间隔', `${maxInterval.interval}秒 (区块 #${maxInterval.fromHeight} → #${maxInterval.toHeight})`);
    reporter.kv('最小间隔', `${minInterval.interval}秒 (区块 #${minInterval.fromHeight} → #${minInterval.toHeight})`);

    // 分布统计
    const intervalRanges = [
        { min: 0, max: 30, label: '0-30s' },
        { min: 31, max: 60, label: '31-60s' },
        { min: 61, max: 120, label: '61-120s' },
        { min: 121, max: 300, label: '121-300s' },
        { min: 301, max: 600, label: '301-600s' },
        { min: 601, max: 1800, label: '601-1800s' },
        { min: 1801, max: Infinity, label: '>1800s' }
    ];
    const intervalDist = histogram(intervalValues, null, intervalRanges).filter(d => d.count > 0);

    reporter.section('间隔时间分布');
    new BarChart(60, 10).draw(intervalDist.map(d => ({ label: d.label, value: d.count })));

    // ============ 绘图数据准备 ============

    // 散点图数据（与 chain_analyzer.go 格式一致）
    const scatterData = intervals.map((item, i) => ({
        x: item.timestamp,
        y: normalized.normalized[i],
        height: item.toHeight,
        interval: item.interval,
        isZero: item.interval <= 0
    }));

    // 平均线的归一化值
    const rangeT = normalized.maxT - normalized.minT || 1;
    const avgIntervalTransformed = normalized.useSqrt
        ? Math.sqrt(secondsPerBlock)
        : secondsPerBlock;
    const avgIntervalNorm = (avgIntervalTransformed - normalized.minT) / rangeT * 100;

    // ============ ASCII 图表（与 chain_analyzer.go 等效）============
    if (config.chart) {
        reporter.section('出块间隔散点图（时间轴）');
        console.log(`※ '*' = 异常出块（0秒或负数） | X轴：时间轴`);
        console.log(`↑ 慢出块 ← 时间 → ↓ 快出块\n`);

        new ScatterTimeChart(80, 15)
            .draw(scatterData, {
                xRange: { min: minTime, max: maxTime + 180 },
                yRange: { min: 0, max: 120 },
                avgLine: Math.min(avgIntervalNorm, 100),
                markers: (point) => point.isZero ? '*' : '█'
            })
            .print('', `${normalized.useSqrt ? '√' : '线性'}归一化 0-100，最大值 ${normalized.maxInterval}秒`);

        console.log(`平均出块时间: ${secondsPerBlock.toFixed(2)}秒 (归一化: ${avgIntervalNorm.toFixed(1)})`);
    }

    // ============ 构建返回数据（供框架使用）============
    const result = {
        info: ANALYZER_INFO,
        config: { startHeight, endHeight },
        data: {
            // 原始数据
            blocks,
            intervals,
            intervalValues,
            // 统计数据
            stats: intervalStats,
            totalDuration,
            blocksPerSecond,
            secondsPerBlock,
            extremes: { max: maxInterval, min: minInterval },
            distribution: intervalDist,
            // 绘图数据
            chartData: {
                scatter: scatterData,
                normalized,
                avgIntervalNorm,
                minTime,
                maxTime,
                timeRange: { min: minTime, max: maxTime + 180 },
                getColor: (interval) => getColor(interval, secondsPerBlock)
            }
        }
    };

    // ============ HTML 报告（使用绘图模块）============
    if (config.html) {
        const builder = new HTMLChartBuilder();

        // 散点图（与 chain_analyzer.go 等效）
        builder.addScatterTimeChart(
            scatterData.map(d => ({
                x: d.x,
                y: d.y,
                height: d.height,
                interval: d.interval,
                zero: d.isZero
            })),
            {
                title: `出块时间间隔散点图 (${normalized.useSqrt ? '√' : '线性'}归一化 0-100，最大 ${normalized.maxInterval}秒)`,
                height: 120,
                avgLine: avgIntervalNorm,
                avgLabel: '平均出块时间',
                avgColor: '#27ae60',
                xLabel: '时间',
                yLabel: '归一化间隔',
                yMin: 0,
                yMax: 120,
                colorFn: (d) => getColor(d.interval, secondsPerBlock),
                pointStyleFn: (d) => d.zero ? 'star' : 'circle',
                pointRadiusFn: (d) => d.zero ? 7 : 3,
                tooltip: {
                    title: (ctx) => {
                        const r = ctx[0].raw;
                        return `高度: ${r.height} | 时间: ${new Date(r.x * 1000).toLocaleString('zh-CN')}`;
                    },
                    label: (ctx) => {
                        const r = ctx.raw;
                        if (r.zero) {
                            return ['Warning: 异常出块！', `实际间隔: ${r.interval} 秒`];
                        }
                        const realInterval = r.interval;
                        const rate = 3600 / realInterval;
                        return [
                            `归一化: ${r.y.toFixed(1)}`,
                            `实际间隔: ${realInterval} 秒`,
                            `相当于: ${rate.toFixed(2)} 块/小时`
                        ];
                    }
                }
            }
        );

        // 分布柱状图
        builder.addBarChart(
            intervalDist.map(d => d.label),
            intervalDist.map(d => d.count),
            {
                title: '间隔时间分布',
                height: 80,
                xLabel: '时间间隔',
                yLabel: '频次',
                colors: intervalDist.map(d => {
                    const avg = parseFloat(d.label);
                    return avg < 60 ? '#27ae60' : avg < 300 ? '#3498db' : '#e74c3c';
                })
            }
        );

        // 保存 HTML
        const htmlPath = builder
            .setTitle(`${ANALYZER_INFO.name}报告 (${startHeight}-${endHeight})`)
            .save(`block-interval_${startHeight}_${endHeight}_${Date.now()}.html`, config.outputDir || './reports');

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
            case '--linear':
                config.linear = true;
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
    console.log(`  node ${__filename} --start 824190 --end 824200 --html --chart`);
    console.log(`  node ${__filename} --html`);
    console.log(`  node ${__filename} --start 824190 --end 824200 --linear --chart`);
}

// ============ 导出和独立运行 ============
module.exports = {
    info: ANALYZER_INFO,
    analyze: analyzeBlockInterval
};

// 独立运行检测
if (require.main === module) {
    const config = parseArgs();
    analyzeBlockInterval(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
