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
    const validIntervalValues = intervalValues.filter(v => v > 0);
    const intervalStats = analyze(validIntervalValues);
    const mu = intervalStats.mean;
    const sigma = intervalStats.stdDev;

    // 时间范围
    const minTime = Math.min(...blocks.map(t => t.time));
    const maxTime = Math.max(...blocks.map(t => t.time));
    const totalDuration = maxTime - minTime;
    const secondsPerBlock = totalDuration / (blocks.length - 1);
    const blocksPerSecond = 1 / secondsPerBlock;

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

        // 散点图 - Y轴用实际分钟数 + 对数刻度，min 锁到真实数据下边界
        const minPosIntervalMin = Math.min(...intervalValues.filter(v => v > 0)) / 60;
        const logYMin = parseFloat((minPosIntervalMin * 0.5).toFixed(4));

        builder.addScatterTimeChart(
            intervals.map(item => ({
                x: item.timestamp,
                y: item.interval > 0 ? item.interval / 60 : logYMin,
                height: item.toHeight,
                interval: item.interval,
                zero: item.interval <= 0
            })),
            {
                title: `出块时间间隔散点图`,
                avgLine: mu / 60,
                avgLabel: `平均出块时间 ${mu.toFixed(1)}s`,
                avgColor: '#27ae60',
                xLabel: '时间',
                yLabel: '间隔时间 (m)',
                useLogScale: true,
                yMin: logYMin,
                colorFn: (d) => getColor(d.interval, secondsPerBlock),
                pointStyleFn: (d) => d.zero ? 'star' : 'circle',
                pointRadiusFn: (d) => d.zero ? 7 : 3,
            }
        );

        // 分布直方图（含正态分布曲线对比）
        const validIntervalVals = validIntervalValues;
        // Freedman-Diaconis 规则：h = 2 × IQR × N^(-1/3)，对极端值鲁棒
        const sortedVals = [...validIntervalVals].sort((a, b) => a - b);
        const q1 = sortedVals[Math.floor(sortedVals.length * 0.25)];
        const q3 = sortedVals[Math.floor(sortedVals.length * 0.75)];
        const iqr = q3 - q1;
        const fdWidth = 2 * iqr * Math.pow(validIntervalVals.length, -1 / 3);
        const mainBinWidth = Math.max(5, Math.round(fdWidth));
        const numMainBins = Math.ceil(intervalStats.p99 / mainBinWidth);
        const outlierMin = numMainBins * mainBinWidth;

        const fineBinLabels = [];
        const fineBinCounts = [];
        const fineBinColors = [];
        const normalCurveData = [];
        const binRanges = [];

        // 比特币理论指数分布：λ=1/600（泊松出块过程）
        const BTC_LAMBDA = 1 / 600;
        const theoreticalCurveData = [];

        for (let i = 0; i < numMainBins; i++) {
            const binMin = i * mainBinWidth;
            const binMax = (i + 1) * mainBinWidth;
            const binCenter = binMin + mainBinWidth / 2;
            const count = validIntervalVals.filter(v => v >= binMin && v < binMax).length;
            fineBinLabels.push(i % 5 === 0 ? `${binMin}s` : '');
            fineBinCounts.push(count);
            fineBinColors.push(binCenter < 60 ? '#27ae60' : binCenter < 300 ? '#3498db' : '#e74c3c');
            binRanges.push({ min: binMin, max: binMax });
            const pdf = sigma > 0
                ? (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * Math.pow((binCenter - mu) / sigma, 2))
                : 0;
            normalCurveData.push(parseFloat((pdf * validIntervalVals.length * mainBinWidth).toFixed(2)));
            const pdfBtc = BTC_LAMBDA * Math.exp(-BTC_LAMBDA * binCenter);
            theoreticalCurveData.push(parseFloat((pdfBtc * validIntervalVals.length * mainBinWidth).toFixed(2)));
        }
        const outlierCount = validIntervalVals.filter(v => v >= outlierMin).length;
        if (outlierCount > 0) {
            fineBinLabels.push(`>${outlierMin}s`);
            fineBinCounts.push(outlierCount);
            fineBinColors.push('#e74c3c');
            normalCurveData.push(0);
            theoreticalCurveData.push(0);
            binRanges.push({ min: outlierMin, max: Infinity });
        }

        builder.addBarChart(
            fineBinLabels,
            fineBinCounts,
            {
                title: '间隔时间分布（正态拟合 vs 指数分布参考）',
                xLabel: '时间间隔',
                yLabel: '频次',
                colors: fineBinColors,
                normalCurve: normalCurveData,
                normalCurve2: theoreticalCurveData,
                binRanges,
                totalCount: validIntervalVals.length
            }
        );

        // 长尾概率说明
        const btcMu = 600;
        const p30  = Math.exp(-1800 / btcMu);
        const p60  = Math.exp(-3600 / btcMu);
        const p120 = Math.exp(-7200 / btcMu);
        builder.addNote(`
            <h3>关于指数分布的长尾</h3>
            <p>
                PoW 出块过程本质是泊松过程：每次 hash 尝试相互独立，成功概率极小。
                两次出块之间的等待时间服从<strong>指数分布</strong>，其生存函数为：
            </p>
            <p style="font-family:monospace; background:#eef; display:inline-block; padding:4px 10px; border-radius:4px;">
                P(T &gt; t) = e<sup>−t/μ</sup>
            </p>
            <p>
                其中 μ 为平均出块时间（本链实测有效间隔均值 <strong>${mu.toFixed(1)}s / ${(mu/60).toFixed(2)}min</strong>，即散点图图例中绿色平均线标注值）。
                指数分布的关键特性是<strong>无记忆性</strong>：
                已经等待了 9 分钟，下一秒出块的概率与刚开始完全相同，历史等待时间不提供任何信息。
            </p>
            <p>以比特币目标 μ=600s 为基准，超过以下时间的理论概率：</p>
            <table>
                <tr><th>等待时长</th><th>P(T &gt; t)</th><th>约每多少块出现一次</th></tr>
                <tr><td>30 分钟</td><td>${(p30 * 100).toFixed(2)}%</td><td>约每 ${Math.round(1/p30)} 块一次</td></tr>
                <tr><td>60 分钟</td><td>${(p60 * 100).toFixed(3)}%</td><td>约每 ${Math.round(1/p60)} 块一次</td></tr>
                <tr><td>120 分钟</td><td>${(p120 * 100).toFixed(5)}%</td><td>约每 ${Math.round(1/p120).toLocaleString()} 块一次</td></tr>
            </table>
            <p>
                数学上指数分布支持集为 [0, +∞)，<strong>不存在理论上限</strong>。
                几小时的长间隔虽然罕见，但并不违反统计规律。
                图中紫色虚线（指数分布参考曲线）从左侧单调递减，
                若实测柱状图在右侧明显高于紫线，说明该链存在非泊松因素（如算力突变、难度调整滞后等）。
            </p>
        `);

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
