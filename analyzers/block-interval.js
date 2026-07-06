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
        { name: 'linear', type: 'boolean', description: '使用线性归一化（默认开平方）', default: false },
        { name: 'include-gaps', type: 'boolean', description: '把大缺口(停机/断链)也计入泊松计数 D（默认剔除，仅统计在线期；开启后所有异常数据进入计算）', default: false },
        { name: 'gap-threshold', type: 'number', description: '大缺口阈值秒数，超过即判为停机/断链（默认 max(窗口×3, 3600)=10800s）', default: null }
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
 * 泊松计数视图：把区块时间(秒)按固定窗口 W 切片，数每窗出块数 k。
 * 理想泊松过程下 k 服从 P(X=k)=(λW)^k·e^(−λW)/k!。
 * opts.excludeGaps=true（默认）时按大缺口分段，避免把停机期算成 0 块窗口（D 仅反映在线期）；
 *   excludeGaps=false 则把整条时间轴铺满窗口，停机期作为 0 块窗口计入 → D 会因停机而偏大（如实反映异常）。
 * opts.gapThreshold 自定义大缺口阈值（秒），默认 max(W×3, 3600)。
 * 返回 {hist, numWindows, maxK, meanCount, dispersion}（dispersion=方差/均值，泊松=1）。
 */
function buildPoissonCounts(timesSec, windowSec, opts = {}) {
    const { excludeGaps = true, gapThreshold } = opts;
    const times = [...timesSec].sort((a, b) => a - b);
    if (times.length < 5) return null;
    const W = windowSec;
    const GAP = excludeGaps ? (gapThreshold || Math.max(W * 3, 3600)) : Infinity;
    const counts = [];
    let seg = [times[0]];
    const flush = () => {
        if (seg.length < 2) return;
        const t0 = seg[0], span = seg[seg.length - 1] - t0;
        const nW = Math.floor(span / W);
        if (nW < 1) return;
        const c = new Array(nW).fill(0);
        for (const t of seg) { const i = Math.floor((t - t0) / W); if (i >= 0 && i < nW) c[i]++; }
        counts.push(...c);
    };
    for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] > GAP) { flush(); seg = []; }
        seg.push(times[i]);
    }
    flush();
    if (counts.length < 1) return null;
    const maxK = Math.max(...counts);
    const hist = new Array(maxK + 1).fill(0);
    for (const c of counts) hist[c]++;
    const meanCount = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - meanCount) ** 2, 0) / counts.length;
    return { hist, numWindows: counts.length, maxK, meanCount, dispersion: meanCount > 0 ? variance / meanCount : 0 };
}

/**
 * 缺口 / 停机汇总：找出相邻区块时间差 > gapThreshold 的所有"大缺口"（停机/断链/数据缺失）。
 * 这些正是泊松计数 excludeGaps 模式下会剔除的窗口，单列出来使"剔除"可见，并作为与 D 解耦的 outage 判据。
 * 返回 { gaps:[{start,end,duration}], count, total, longest }（单位与输入一致）。
 */
function summarizeGaps(timesSec, gapThreshold) {
    const times = [...timesSec].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > gapThreshold) gaps.push({ start: times[i - 1], end: times[i], duration: d });
    }
    const total = gaps.reduce((a, g) => a + g.duration, 0);
    const longest = gaps.reduce((m, g) => Math.max(m, g.duration), 0);
    return { gaps, count: gaps.length, total, longest };
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

        // 出块间隔概率分布（实测 vs BTC 理论对比）—— 线性时间轴 + 概率密度，曲线下面积=出块概率
        // BTC 出块目标 600s，间隔服从指数分布 Exp(λ=1/600)。
        const BTC_TARGET_S = 600;
        const validIv = validIntervalValues;
        {
            const hasEnoughIntervals = validIv.length >= 2;
            const fallbackBinWidth = 5;
            let binWidth = fallbackBinWidth;
            let numBins = 0;
            let counts = [];

            if (hasEnoughIntervals) {
                // Freedman-Diaconis 规则：h = 2 × IQR × N^(-1/3)，对极端值鲁棒
                const sorted = [...validIv].sort((a, b) => a - b);
                const q1 = sorted[Math.floor(sorted.length * 0.25)];
                const q3 = sorted[Math.floor(sorted.length * 0.75)];
                const iqr = q3 - q1;
                const fdWidth = 2 * iqr * Math.pow(validIv.length, -1 / 3);
                binWidth = Math.max(fallbackBinWidth, Math.round(fdWidth || fallbackBinWidth));
                numBins = Math.max(1, Math.ceil((intervalStats.p99 || intervalStats.max) / binWidth));
                const outlierMin = numBins * binWidth;

                // 各 bin 频次（闭箱）+ 末尾 >outlier 开箱
                for (let i = 0; i < numBins; i++) {
                    const bMin = i * binWidth, bMax = (i + 1) * binWidth;
                    counts.push(validIv.filter(v => v >= bMin && v < bMax).length);
                }
                const outlierCount = validIv.filter(v => v >= outlierMin).length;
                if (outlierCount > 0) counts.push(outlierCount);
            }

            // 四个不重叠区间(分割点 1/10/30 分钟)的出块概率：实测从原始间隔精确统计，BTC 用 CDF
            const N = validIv.length;
            const lamB = 1 / BTC_TARGET_S;
            const empCnt = (a, b) => N > 0 ? validIv.filter(v => v >= a && v < b).length / N : null; // 实测 P(a≤T<b)
            const Pexp = (a, b, lam) => Math.exp(-lam * a) - Math.exp(-lam * b);      // 理论 P(a<T<b)
            const pc = v => (v * 100).toFixed(1) + '%';
            // 轴从 0 起，四个不重叠区间：<1m / 1–10m / 10–30m / >30m，各标自身出块概率
            const regions = [
                { name: '快块 <1m',  x0: 0,  x1: 1,  emp: empCnt(0, 60),         btc: Pexp(0, 60, lamB),         fill: 'rgba(39,174,96,0.10)',  line: '#27ae60' },
                { name: '1–10m',     x0: 1,  x1: 10, emp: empCnt(60, 600),        btc: Pexp(60, 600, lamB),       fill: 'rgba(41,128,185,0.09)', line: '#2980b9' },
                { name: '10–30m',    x0: 10, x1: 30, emp: empCnt(600, 1800),      btc: Pexp(600, 1800, lamB),     fill: 'rgba(243,156,18,0.10)', line: '#e67e22' },
                { name: '长块 >30m', x0: 30, x1: 45, emp: empCnt(1800, Infinity), btc: Pexp(1800, Infinity, lamB), fill: 'rgba(231,76,60,0.10)',  line: '#e74c3c' },
            ];
            // <1min 细分（注释用）—— 直接数整数计数，避免占比×N 的浮点误差
            const cntIv = (a, b) => validIv.filter(v => v >= a && v < b).length;
            const sub1 = cntIv(0, 60), minIv = validIv.length ? Math.min(...validIv) : null;
            const sub1Note = N > 0
                ? `<br><b>间隔 &lt;1min 细分</b>：共 <b>${sub1}</b> 个（${pc(sub1 / N)}）；`
                    + `&lt;10s ${cntIv(0, 10)} 个、10–30s ${cntIv(10, 30)} 个、30–60s ${cntIv(30, 60)} 个；最短间隔 ${minIv.toFixed(0)}s。`
                : '<br><b>实测间隔样本不足</b>：未能计算本链实测密度，仅显示 BTC 理论曲线。';
            // 累计概率(用户口径)：P(<m分钟)
            const cumEmp = m => N > 0 ? validIv.filter(v => v < m * 60).length / N : null;
            // ≤0 间隔(同刻/乱序)出块的实测核查（validIv 已滤 >0，这里从未过滤的 intervalValues 数）
            const zeroNeg = intervalValues.filter(v => v != null && v <= 0).length;
            // 图内左上角注：≤0 间隔的实测说明
            const cornerNotes = [
                { text: zeroNeg > 0 ? `⚠ 间隔≤0(同刻/乱序)的块：${zeroNeg} 个` : (minIv != null ? `实测无间隔≤0的块（最短 ${minIv.toFixed(0)}s）` : '实测有效间隔不足，BTC理论曲线仍独立显示'), color: '#777' },
            ];
            const cumLine = N > 0
                ? `<br><b>累计概率</b>：`
                    + `P(&lt;1m) 实测${pc(cumEmp(1))}/BTC${pc(1 - Math.exp(-60 * lamB))} · `
                    + `P(&lt;10m) 实测${pc(cumEmp(10))}/BTC${pc(1 - Math.exp(-600 * lamB))} · `
                    + `P(&lt;30m) 实测${pc(cumEmp(30))}/BTC${pc(1 - Math.exp(-1800 * lamB))} · `
                    + `P(&gt;30m) 实测${pc(1 - cumEmp(30))}/BTC${pc(Math.exp(-1800 * lamB))}`
                : `<br><b>累计概率</b>：BTC P(&lt;1m) ${pc(1 - Math.exp(-60 * lamB))} · P(&lt;10m) ${pc(1 - Math.exp(-600 * lamB))} · P(&lt;30m) ${pc(1 - Math.exp(-1800 * lamB))} · P(&gt;30m) ${pc(Math.exp(-1800 * lamB))}`;
            const muText = hasEnoughIntervals && Number.isFinite(mu) && mu > 0 ? `${mu.toFixed(0)}s` : '样本不足';

            // 线性时间轴(0~45min)、纵轴概率密度：曲线下某区间面积=该区间出块概率；10min 处粗分割线
            builder.addProbDistChart({
                title: '出块间隔概率分布（实测 vs BTC 理论对比）',
                caption: '横轴=出块间隔(分钟)。<b>蓝色填充曲线=BTC 理论分布，红线=本链实测</b>；红线贴合蓝线 → 本链出块≈比特币理论。'
                    + '四个区带分别标出 <b>&lt;1m / 1–10m / 10–30m / &gt;30m</b> 各自出块概率(实测 vs BTC 理论，四区相加=100%)；<b>10min 粗线=BTC 目标</b>。'
                    + sub1Note
                    + `<br><b>生成公式</b>：密度曲线 <code>f(t)=λ·e<sup>−λt</sup></code>（速率 λ=1/μ：BTC μ=600s，实测 μ=${muText}）；`
                    + '区间<b>理论</b>概率 <code>P(a≤t&lt;b)=e<sup>−λa</sup>−e<sup>−λb</sup></code>（a、b 单位秒），区间<b>实测</b>概率 = 该区间样本数 ÷ 总数 N。'
                    + '纵轴是概率<b>密度</b>(1/分钟)非概率，概率=曲线下面积；密度在 t→0 处最高(≈λ)、单调下降，这是无记忆泊松过程的真实形状。'
                    + cumLine,
                counts, closedBins: numBins, totalCount: N,
                binWidth, muSelf: mu, btcTarget: BTC_TARGET_S,
                xMinM: 0, xMaxM: 45, boldLineMin: 10, dividers: [1, 10, 30], regions, cornerNotes,
            });
        }

        // 长尾概率说明
        const btcMu = 600;
        const p30  = Math.exp(-1800 / btcMu);
        const p60  = Math.exp(-3600 / btcMu);
        const p120 = Math.exp(-7200 / btcMu);
        builder.addNote(`
            <h3>间隔分布形状判定（CV）</h3>
            <p>变异系数 <strong>CV = σ/μ = ${(sigma / mu).toFixed(3)}</strong>（指数分布理论值 = 1.00）。
               ${Math.abs(sigma / mu - 1) < 0.15
                 ? '<strong style="color:#27ae60">≈1 → 形状符合指数分布（健康泊松出块）</strong>'
                 : (sigma / mu > 1 ? '<strong style="color:#e67e22">＞1 → 长尾偏重</strong>' : '<strong style="color:#e67e22">＜1 → 过于规整</strong>')}。
               上图“出块间隔概率分布”中红线 = 本链实测、蓝色填充曲线 = BTC 理论分布(λ=1/600)；红线贴合蓝线即服从指数。</p>
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

        // 出块计数泊松分布（每小时出块数；间隔指数图的对偶视角）
        // 缺口开关：默认剔除大缺口（D 仅反映在线期）；--include-gaps 则全部计入（停机也进 D）。
        const excludeGaps = config.includeGaps !== true;
        const gapThreshold = config.gapThreshold || Math.max(3600 * 3, 3600);
        const gapInfo = summarizeGaps(blocks.map(b => b.time), gapThreshold);
        const pv = buildPoissonCounts(blocks.map(b => b.time), 3600, { excludeGaps, gapThreshold });
        if (pv && pv.numWindows >= 3 && mu > 0) {
            const fact = (k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
            const pmf = (k, m) => Math.pow(m, k) * Math.exp(-m) / fact(k);
            const meanMeas = 3600 / mu;   // λW 实测 = W/μ
            const meanBtc = 3600 / 600;    // λW BTC  = W/600
            const kMax = Math.max(pv.maxK + 2, Math.ceil(meanBtc * 1.5) + 1);
            const pLabels = [], pCounts = [], pColors = [], measCurve = [], btcCurve = [];
            for (let k = 0; k <= kMax; k++) {
                pLabels.push(String(k));
                pCounts.push(pv.hist[k] || 0);
                pColors.push('#3498db');
                measCurve.push(parseFloat((pv.numWindows * pmf(k, meanMeas)).toFixed(2)));
                btcCurve.push(parseFloat((pv.numWindows * pmf(k, meanBtc)).toFixed(2)));
            }
            const band = 2 * Math.sqrt(2 / Math.max(pv.numWindows - 1, 1));
            const D = pv.dispersion;
            const dOk = Math.abs(D - 1) <= band;
            const verdict = dOk ? '✅ 符合泊松(D≈1)'
                          : (D < 1 ? '❌ 过于规整(D<1,出块比泊松更均匀→疑节流/调控)'
                                   : '❌ 过度聚集(D>1,比泊松更扎堆)');
            builder.addBarChart(pLabels, pCounts, {
                title: `每1 小时出块数分布 · 离散指数 D=${D.toFixed(2)} ${verdict}`,
                xLabel: '窗口内出块数 k（一个小时里出了几个块）', yLabel: '窗口数（有多少个这样的小时）',
                colors: pColors,
                normalCurve: measCurve, normalCurveLabel: `实测泊松 均值${meanMeas.toFixed(2)} 块/小时 (=3600/μ)`,
                normalCurve2: btcCurve, normalCurve2Label: `BTC 泊松 均值${meanBtc.toFixed(2)} 块/小时`,
                totalCount: pv.numWindows,
            });
            builder.addNote(`
                <h3>出块计数泊松检验（上图：每 1 小时出块数分布）</h3>
                <p>把时间轴切成 1 小时固定窗口（共 <b>${pv.numWindows}</b> 个，${excludeGaps ? '已按大缺口<b>剔除</b>停机期' : '<b>含</b>停机期(<code>--include-gaps</code>)'}），数每窗出几个块 k。
                   理想泊松过程下 k 服从
                   <span style="font-family:monospace;background:#eef;padding:2px 8px;border-radius:4px;">P(X=k) = (λW)<sup>k</sup>·e<sup>−λW</sup> / k!</span>，
                   曲线值 = 窗口数 × P(X=k)。下表按<strong>本数据实测</strong>列出：</p>
                <table>
                    <tr><th>项</th><th>数值（本数据）</th><th>含义 / 判读</th></tr>
                    <tr><td>窗口长度 W</td><td>1 小时（3600s）</td><td>每个计数窗口的时长</td></tr>
                    <tr><td>窗口个数 N</td><td>${pv.numWindows}</td><td>样本量；越多柱子越平滑可信</td></tr>
                    <tr><td>实测 λW（红线均值）</td><td>${meanMeas.toFixed(2)} 块/窗</td><td>= W/μ（μ=${mu.toFixed(0)}s）</td></tr>
                    <tr><td>BTC λW（紫虚线均值）</td><td>${meanBtc.toFixed(2)} 块/窗</td><td>= W/600，BTC 参考</td></tr>
                    <tr><td>离散指数 D = σ²/均值</td><td><b>${D.toFixed(3)}</b></td><td>泊松理论 = 1.00 —— <strong>判正常与否的核心指标</strong></td></tr>
                    <tr><td>95% 容许带</td><td>[${(1 - band).toFixed(2)}, ${(1 + band).toFixed(2)}]</td><td>1 ± 2√(2/(N−1))；D 落带内即正常</td></tr>
                    <tr><td><strong>判定</strong></td><td><strong style="color:${dOk ? '#27ae60' : '#e74c3c'}">${verdict}</strong></td><td>D 在带内 → 符合泊松；偏出 → 异常</td></tr>
                </table>
                <p style="font-size:13px;color:#666;">不必肉眼比对每根柱——柱子是计数，天然有 ±√值 抖动（个别柱高/低 1~2σ 正常）。<b>只看 D 与判定</b>：与上面"间隔分布(CV)"是同一过程的计数视角 vs 间隔视角，应同时为 ✅。</p>
                <p style="font-size:13px;color:#888;">单位提醒：本图均值是<b>块/小时</b>（每窗出几个块），间隔图的 μ 是<b>秒/块</b>，二者互为倒数 <b>均值 = 3600 / μ</b>。间隔越短 ⟺ 每小时出块越多，两数方向相反是必然，<b>不矛盾</b>。</p>`);
        }

        // ---- 缺口 / 停机汇总 + outage 判据（让"剔除"可见，并与离散指数 D 解耦地报告停机）----
        {
            const fmtDur = s => s >= 3600 ? `${(s / 3600).toFixed(2)} h` : (s >= 60 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
            const fmtTs = sec => new Date(sec * 1000).toISOString().replace('T', ' ').replace('.000Z', '');
            const rows = gapInfo.gaps
                .slice().sort((a, b) => b.duration - a.duration)
                .map(g => `<tr><td>${fmtTs(g.start)} → ${fmtTs(g.end)} UTC</td><td>${fmtDur(g.duration)}</td>`
                    + `<td>≈ 丢失 ${mu > 0 ? Math.round(g.duration / mu) : '?'} 个区块时间（${mu > 0 ? (g.duration / mu).toFixed(0) : '?'}×μ）</td></tr>`)
                .join('');
            const outageVerdict = gapInfo.count > 0
                ? `<strong style="color:#e74c3c">⚠ 检测到 ${gapInfo.count} 次停机/断链</strong>（最长 ${fmtDur(gapInfo.longest)}，累计 ${fmtDur(gapInfo.total)}）`
                : `<strong style="color:#27ae60">✅ 无大缺口（无超过阈值的停机）</strong>`;
            const modeTxt = excludeGaps
                ? '本次为<b>剔除模式</b>（默认）：以下缺口<b>已从泊松计数 D 中剔除</b>，D 仅反映"在线期"出块节奏。要让 D 把停机也算进去，运行时加 <code>--include-gaps</code>。'
                : '本次为<b>包含模式</b>（<code>--include-gaps</code>）：以下缺口<b>已计入泊松计数</b>，D 会因停机而偏大（过度离散，如实反映异常）。';
            builder.addNote(`
                <h3>缺口 / 停机汇总（outage 判据，与离散指数 D 解耦）</h3>
                <p>大缺口阈值 = <b>${fmtDur(gapThreshold)}</b>（${gapThreshold}s，<code>--gap-threshold</code> 可调）。相邻区块间隔超过该阈值即判为<b>停机 / 断链 / 数据缺失</b>，独立于 D 单独报告——这样泊松计数“剔除了什么”始终可见，不会用一个 ✅ 把真实停机洗白。</p>
                <p>判定：${outageVerdict}</p>
                <p style="font-size:13px;color:#666;">${modeTxt}</p>
                ${gapInfo.count > 0 ? `<table><tr><th>缺口区间 (UTC)</th><th>时长</th><th>影响（相对实测 μ=${mu.toFixed(0)}s）</th></tr>${rows}</table>` : ''}
            `);
        }

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
            case '--include-gaps':
                config.includeGaps = true;
                break;
            case '--gap-threshold':
                config.gapThreshold = parseInt(args[++i], 10);
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
