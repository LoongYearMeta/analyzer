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

const fs = require('fs');
const path = require('path');
const { RPCClient } = require('../lib/rpc');
const { analyze, histogram } = require('../lib/stats');
const { Reporter } = require('../lib/reporter');
const { LineChart, BarChart, HTMLChartBuilder } = require('../lib/charts');

// ============ 并发控制 + 超时重试 ============
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RETRIES = 2;

// 限制并发执行 async fn(item) 的辅助函数
async function asyncPool(concurrency, items, fn) {
    const results = new Array(items.length);
    const iter = items.entries();
    const workers = Array.from({ length: concurrency }, async () => {
        for (const [i, item] of iter) {
            results[i] = await fn(item);
        }
    });
    await Promise.all(workers);
    return results;
}

// 对瞬时 RPC 超时做有限重试, 避免偶发网络抖动导致整批失败
async function withRetry(fn, { retries = DEFAULT_RETRIES, label = '' } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const isTimeout = /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(err.message);
            if (!isTimeout || attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
    }
    throw lastErr;
}

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
        { name: 'concurrency', alias: 'c', type: 'number', description: 'RPC 并发数（默认 8，越大越快但越容易引起超时）', default: DEFAULT_CONCURRENCY },
        { name: 'ancestor-ratio', alias: 'A', type: 'boolean', description: '计算区块内交易数 / 最大祖先高度', default: false },
        { name: 'sv2-log', alias: 'L', type: 'string', description: 'SV2 性能日志文件路径；传入后切换到日志分析模式', default: null },
        { name: 'html', type: 'boolean', description: '生成 HTML 报告', default: false },
        { name: 'chart', type: 'boolean', description: '显示 ASCII 图表', default: false }
    ]
};

function calculateBlockAncestorStats(txs) {
    const depthMap = new Map();
    let maxDepth = 0;
    let txCount = 0;

    for (const tx of txs || []) {
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
        maxDepth = Math.max(maxDepth, depth);
        txCount++;
    }

    const maxAncestorHeight = txCount > 0 ? maxDepth + 1 : 0;
    const ratio = maxAncestorHeight > 0 ? txCount / maxAncestorHeight : 0;

    return { txCount, maxDepth, maxAncestorHeight, ratio };
}

function parseLogTimestampPrefix(line) {
    const m = line.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? \[[^\]]+\] (.*)$/);
    if (!m) {
        return { timestampUs: null, message: line.trim(), hasTimestamp: false };
    }

    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const minute = parseInt(m[5], 10);
    const second = parseInt(m[6], 10);
    const micros = m[7] ? parseInt(m[7].padEnd(6, '0'), 10) : 0;
    const timestampUs = new Date(year, month, day, hour, minute, second, 0).getTime() * 1000 + micros;
    return { timestampUs, message: m[8], hasTimestamp: true, hasMicros: !!m[7] };
}

function parseKeyValues(text) {
    const out = {};
    const re = /([A-Za-z0-9_-]+)=([^\s]+)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        out[match[1]] = match[2];
    }
    return out;
}

function parseSv2PerfLine(line) {
    const { timestampUs, message, hasTimestamp, hasMicros } = parseLogTimestampPrefix(line);
    const payload = message || line.trim();
    const kv = parseKeyValues(payload);
    const event = kv.event || (payload.includes('template_create_cs_main') ? 'template_create_cs_main' : null);

    if (!event) return null;

    const toNum = v => v == null ? null : Number(v);
    const record = {
        raw: line,
        timestampUs,
        hasTimestamp,
        hasMicros,
        event,
        height: kv.height != null ? parseInt(kv.height, 10) : null,
        txs: kv.txs != null ? parseInt(kv.txs, 10) : null,
        sizeNoCb: kv.size_no_cb != null ? Number(kv.size_no_cb) : null,
        totalSize: kv.total_size != null ? Number(kv.total_size) : null,
        totalUs: kv.total_us != null ? Number(kv.total_us) : null,
        csMainUs: kv.cs_main_us != null ? Number(kv.cs_main_us) : null,
        processNewBlockUs: kv.process_new_block_us != null ? Number(kv.process_new_block_us) : null,
        getTipUs: kv.get_tip_us != null ? Number(kv.get_tip_us) : null,
        ok: kv.ok != null ? Number(kv.ok) : null,
        templateId: kv.template_id != null ? Number(kv.template_id) : null,
        future: kv.future != null ? Number(kv.future) : null,
        prevhash: kv.prevhash || null
    };

    if (record.timestampUs != null && record.totalUs != null) {
        record.startUs = record.timestampUs - Math.round(record.totalUs);
    }
    if (record.timestampUs != null && record.csMainUs != null) {
        record.csMainStartUs = record.timestampUs - Math.round(record.csMainUs);
    }
    return record;
}

function sortByXThenHeight(a, b) {
    if (a.x !== b.x) return a.x - b.x;
    if (a.height != null && b.height != null && a.height !== b.height) return a.height - b.height;
    return 0;
}

function makeLineSeries(points, xFormatter = x => String(x)) {
    const ordered = [...points].sort(sortByXThenHeight);
    return {
        labels: ordered.map(p => xFormatter(p.x)),
        values: ordered.map(p => p.y),
        points: ordered
    };
}

function buildSv2LogAnalysis(records) {
    const create = records.filter(r => r.event === 'template_create' && (r.ok == null || r.ok === 1) && r.height != null);
    const createCsMain = records.filter(r => r.event === 'template_create_cs_main' && r.height != null && r.csMainUs != null);
    const submit = records.filter(r => r.event === 'submit_solution' && (r.ok == null || r.ok === 1) && r.height != null);

    const byHeight = new Map();
    for (const r of create) {
        if (!byHeight.has(r.height)) byHeight.set(r.height, []);
        byHeight.get(r.height).push(r);
    }

    const byHeightCs = new Map();
    for (const r of createCsMain) {
        if (!byHeightCs.has(r.height)) byHeightCs.set(r.height, []);
        byHeightCs.get(r.height).push(r);
    }

    const byHeightSubmit = new Map();
    for (const r of submit) {
        if (!byHeightSubmit.has(r.height)) byHeightSubmit.set(r.height, []);
        byHeightSubmit.get(r.height).push(r);
    }

    const createSeries = [];
    const createSizeSeries = [];
    const createCsMainSeries = [];
    const submitSeries = [];
    const submitSizeSeries = [];
    const intervalSeries = [];

    const heights = [...new Set([...byHeight.keys(), ...byHeightCs.keys(), ...byHeightSubmit.keys()])].sort((a, b) => a - b);
    const heightSummaries = [];

    for (const height of heights) {
        const createRows = byHeight.get(height) || [];
        const csRows = byHeightCs.get(height) || [];
        const submitRows = byHeightSubmit.get(height) || [];

        const startUs = createRows.length > 0
            ? Math.min(...createRows.filter(r => r.startUs != null).map(r => r.startUs))
            : null;
        const csMainUs = csRows.reduce((sum, r) => sum + (r.csMainUs || 0), 0);
        const totalSize = createRows.reduce((max, r) => Math.max(max, r.totalSize || 0), 0) ||
            csRows.reduce((max, r) => Math.max(max, r.totalSize || 0), 0) ||
            submitRows.reduce((max, r) => Math.max(max, r.totalSize || 0), 0);
        const totalUs = createRows.reduce((sum, r) => sum + (r.totalUs || 0), 0);
        const submitUs = submitRows.reduce((sum, r) => sum + (r.processNewBlockUs || 0), 0);
        const txs = createRows.reduce((max, r) => Math.max(max, r.txs || 0), 0) ||
            csRows.reduce((max, r) => Math.max(max, r.txs || 0), 0) ||
            submitRows.reduce((max, r) => Math.max(max, r.txs || 0), 0);

        if (createRows.length > 0) {
            createSeries.push({ x: txs, y: totalUs, height });
            createSizeSeries.push({ x: txs, y: totalSize, height });
            heightSummaries.push({ height, startUs, csMainUs, txs, totalSize, totalUs });
        }

        if (csRows.length > 0) {
            createCsMainSeries.push({ x: txs, y: csMainUs, height });
        }

        if (submitRows.length > 0) {
            submitSeries.push({ x: txs, y: submitUs, height });
            submitSizeSeries.push({ x: txs, y: totalSize, height });
        }
    }

    const orderedHeights = heightSummaries.filter(r => r.startUs != null).sort((a, b) => a.height - b.height);
    for (let i = 0; i < orderedHeights.length - 1; i++) {
        const cur = orderedHeights[i];
        const next = orderedHeights[i + 1];
        const intervalUs = next.startUs - cur.startUs;
        if (intervalUs > 0) {
            intervalSeries.push({
                x: cur.height,
                y: +(cur.csMainUs / intervalUs).toFixed(6),
                height: cur.height,
                nextHeight: next.height,
                intervalUs
            });
        }
    }

    const createTotalUs = create.map(r => r.totalUs).filter(v => v != null);
    const createTotalSize = create.map(r => r.totalSize).filter(v => v != null);
    const createCsMainUs = createCsMain.map(r => r.csMainUs).filter(v => v != null);
    const submitProcessUs = submit.map(r => r.processNewBlockUs).filter(v => v != null);
    const submitTotalSize = submit.map(r => r.totalSize).filter(v => v != null);

    const warnings = [];
    if (records.some(r => !r.hasTimestamp)) {
        warnings.push('日志缺少时间戳前缀，h(n-1)->h(n) 连续图已跳过或降级');
    } else if (records.some(r => !r.hasMicros)) {
        warnings.push('日志没有微秒时间戳，连续图会按秒级近似，建议启用 -logtimemicros=1');
    }

    return {
        mode: 'sv2-log',
        records,
        create,
        createCsMain,
        submit,
        series: {
            createTotalUs: makeLineSeries(createSeries, x => String(x)),
            createTotalSize: makeLineSeries(createSizeSeries, x => String(x)),
            createCsMainUs: makeLineSeries(createCsMainSeries, x => String(x)),
            submitProcessUs: makeLineSeries(submitSeries, x => String(x)),
            submitTotalSize: makeLineSeries(submitSizeSeries, x => String(x)),
            intervalOccupancy: makeLineSeries(intervalSeries, x => `h${x}->h${x + 1}`)
        },
        stats: {
            createTotalUs: createTotalUs.length ? analyze(createTotalUs) : null,
            createTotalSize: createTotalSize.length ? analyze(createTotalSize) : null,
            createCsMainUs: createCsMainUs.length ? analyze(createCsMainUs) : null,
            submitProcessUs: submitProcessUs.length ? analyze(submitProcessUs) : null,
            submitTotalSize: submitTotalSize.length ? analyze(submitTotalSize) : null
        },
        heights: orderedHeights,
        intervalSeries,
        warnings
    };
}

function loadSv2Log(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`日志文件不存在: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(line => line.trim());
    const records = [];
    for (const line of lines) {
        const rec = parseSv2PerfLine(line);
        if (rec) records.push(rec);
    }
    return records;
}

function buildSv2Html(builder, analysis, titlePrefix) {
    const s = analysis.series;
    if (analysis.warnings.length > 0) {
        builder.addNote(`<h3>说明</h3><ul>${analysis.warnings.map(w => `<li>${w}</li>`).join('')}</ul>`);
    }
    if (s.createTotalUs.values.length > 0) {
        builder.addLineChart(s.createTotalUs.labels, s.createTotalUs.values, {
            title: `${titlePrefix} - 创建模板耗时 vs 交易数量`,
            label: '创建模板耗时 (us)',
            borderColor: 'rgb(102, 126, 234)',
            backgroundColor: 'rgba(102, 126, 234, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            xLabel: '交易数量',
            yLabel: '耗时 (us)'
        });
    }
    if (s.createTotalSize.values.length > 0) {
        builder.addLineChart(s.createTotalSize.labels, s.createTotalSize.values, {
            title: `${titlePrefix} - 创建模板总大小 vs 交易数量`,
            label: '总大小 (bytes)',
            borderColor: 'rgb(46, 204, 113)',
            backgroundColor: 'rgba(46, 204, 113, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            xLabel: '交易数量',
            yLabel: '总大小 (bytes)'
        });
    }
    if (s.createCsMainUs.values.length > 0) {
        builder.addLineChart(s.createCsMainUs.labels, s.createCsMainUs.values, {
            title: `${titlePrefix} - 创建模板 cs_main 占用 vs 交易数量`,
            label: 'cs_main (us)',
            borderColor: 'rgb(231, 76, 60)',
            backgroundColor: 'rgba(231, 76, 60, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            xLabel: '交易数量',
            yLabel: 'cs_main (us)'
        });
    }
    if (s.submitProcessUs.values.length > 0) {
        builder.addLineChart(s.submitProcessUs.labels, s.submitProcessUs.values, {
            title: `${titlePrefix} - 验证/提交耗时 vs 交易数量`,
            label: 'ProcessNewBlock (us)',
            borderColor: 'rgb(155, 89, 182)',
            backgroundColor: 'rgba(155, 89, 182, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            xLabel: '交易数量',
            yLabel: '耗时 (us)'
        });
    }
    if (s.submitTotalSize.values.length > 0) {
        builder.addLineChart(s.submitTotalSize.labels, s.submitTotalSize.values, {
            title: `${titlePrefix} - 验证模板总大小 vs 交易数量`,
            label: '总大小 (bytes)',
            borderColor: 'rgb(243, 156, 18)',
            backgroundColor: 'rgba(243, 156, 18, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            xLabel: '交易数量',
            yLabel: '总大小 (bytes)'
        });
    }
    if (s.intervalOccupancy.values.length > 0) {
        builder.addLineChart(s.intervalOccupancy.labels, s.intervalOccupancy.values, {
            title: `${titlePrefix} - 相邻高度区间 cs_main 占用比`,
            label: '占用比',
            borderColor: 'rgb(127, 140, 141)',
            backgroundColor: 'rgba(127, 140, 141, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            xLabel: '高度区间',
            yLabel: '占用比'
        });
    }
}

// ============ 核心分析逻辑 ============
async function analyzeTxCount(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    if (config.sv2LogFile) {
        return analyzeSv2Log(config, reporter);
    }

    // 确定区块范围
    const latestHeight = await rpc.getBlockCount();
    let startHeight = config.start || Math.max(1, latestHeight - 999);
    let endHeight = config.end || latestHeight;
    const useAncestorRatio = !!config.ancestorRatio;
    const blockVerbosity = useAncestorRatio ? 2 : 1;

    // 校验范围: 超出链尖的高度根本不存在, getblockhash 会报
    // "Block height out of range", 这与交易数量无关。提前收敛避免刷屏报错。
    if (startHeight > latestHeight) {
        throw new Error(`起始高度 ${startHeight} 超过当前链尖 ${latestHeight}, 无可分析区块`);
    }
    if (endHeight > latestHeight) {
        reporter.log(`⚠️  结束高度 ${endHeight} 超过当前链尖 ${latestHeight}, 已截断到 ${latestHeight}`);
        endHeight = latestHeight;
    }

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} - ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);

    // 获取数据
    const blockData = [];
    const batchSize = 100;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;
    const totalBlocks = endHeight - startHeight + 1;

    for (let h = startHeight; h <= endHeight; h += batchSize) {
        const batchEnd = Math.min(h + batchSize - 1, endHeight);
        const heights = [];
        for (let height = h; height <= batchEnd; height++) heights.push(height);

        const results = await asyncPool(concurrency, heights, height =>
            withRetry(
                () => rpc.getBlock(height, blockVerbosity)
                    .then(block => ({
                        height,
                        numTx: block.nTx || (block.tx ? block.tx.length : 0),
                        size: block.size ?? null,
                        time: block.time,
                        hash: block.hash,
                        ancestor: useAncestorRatio && Array.isArray(block.tx) ? calculateBlockAncestorStats(block.tx) : null
                    }))
                    .catch(err => {
                        reporter.error(`获取区块 ${height} 失败:`, err.message);
                        return null;
                    }),
                { retries: DEFAULT_RETRIES, label: `区块 ${height}` }
            )
        );

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

    const sizes = blockData.map(b => b.size).filter(v => v != null);
    const sizeStats = sizes.length > 0 ? analyze(sizes) : null;
    const ancestorRatios = useAncestorRatio
        ? blockData.map(b => b.ancestor?.ratio).filter(v => v != null)
        : [];
    const ancestorRatioStats = ancestorRatios.length > 0 ? analyze(ancestorRatios) : null;

    // 输出统计结果
    reporter.section('统计结果');
    reporter.stats(stats);

    // 找出极值区块
    const maxBlock = blockData.reduce((max, b) => b.numTx > max.numTx ? b : max);
    const minBlock = blockData.reduce((min, b) => b.numTx < min.numTx ? b : min);

    reporter.section('极值区块');
    reporter.kv('交易最多', `区块 #${maxBlock.height}: ${maxBlock.numTx} 笔`);
    reporter.kv('交易最少', `区块 #${minBlock.height}: ${minBlock.numTx} 笔`);

    if (sizeStats) {
        reporter.section('区块大小统计');
        reporter.stats(sizeStats);

        const maxSizeBlock = blockData.reduce((max, b) => (b.size != null && b.size > max.size) ? b : max);
        const minSizeBlock = blockData.reduce((min, b) => (b.size != null && b.size < min.size) ? b : min);
        reporter.kv('区块最大', `区块 #${maxSizeBlock.height}: ${(maxSizeBlock.size / 1024).toFixed(2)} KB`);
        reporter.kv('区块最小', `区块 #${minSizeBlock.height}: ${(minSizeBlock.size / 1024).toFixed(2)} KB`);
    }

    if (ancestorRatioStats) {
        reporter.section('祖先比值统计');
        reporter.kv('平均值', ancestorRatioStats.mean.toFixed(6));
        reporter.kv('最大值', ancestorRatioStats.max.toFixed(6));
        reporter.kv('最小值', ancestorRatioStats.min.toFixed(6));
    }

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
        sizeTrend: {
            labels: blockData.map(b => `#${b.height}`),
            values: blockData.map(b => b.size != null ? +(b.size / 1024).toFixed(2) : null)
        },
        distribution: dist.map(d => ({ label: d.label, count: d.count })),
        stats,
        sizeStats,
        ancestorRatio: ancestorRatioStats ? {
            labels: blockData.filter(b => b.ancestor?.ratio != null).map(b => `#${b.height}`),
            values: blockData.filter(b => b.ancestor?.ratio != null).map(b => b.ancestor.ratio)
        } : null,
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

        if (ancestorRatioStats) {
            reporter.section('祖先比值趋势图');
            const ratioSample = blockData.filter(b => b.ancestor?.ratio != null);
            new LineChart(80, 12)
                .draw(
                    ratioSample.map(b => b.ancestor.ratio),
                    ratioSample.map(b => `#${b.height}`),
                    {
                        avgLine: ancestorRatioStats.mean,
                        pointChar: '●'
                    }
                )
                .print('', `平均值: ${ancestorRatioStats.mean.toFixed(6)}`);
        }
    }

    // ============ 构建返回数据 ============
    const result = {
        info: ANALYZER_INFO,
        config: { startHeight, endHeight },
        data: {
            blockData,
            txCounts,
            sizes,
            stats,
            sizeStats,
            ancestorRatioStats,
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
                label: '交易数量',
                borderColor: 'rgb(102, 126, 234)',
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

        if (chartData.sizeTrend.values.some(v => v != null)) {
            builder.addLineChart(
                chartData.sizeTrend.labels,
                chartData.sizeTrend.values,
                {
                    title: '区块大小趋势',
                    label: '区块大小 (KB)',
                    borderColor: 'rgb(46, 204, 113)',
                    backgroundColor: 'rgba(46, 204, 113, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    xLabel: '区块高度',
                    yLabel: '大小 (KB)'
                }
            );
        }

        if (chartData.ancestorRatio?.values?.length > 0) {
            builder.addLineChart(
                chartData.ancestorRatio.labels,
                chartData.ancestorRatio.values,
                {
                    title: '区块内交易数 / 最大祖先高度',
                    label: '比值',
                    borderColor: 'rgb(155, 89, 182)',
                    backgroundColor: 'rgba(155, 89, 182, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    xLabel: '区块高度',
                    yLabel: '比值'
                }
            );
        }

        if (chartData.ancestorRatio?.values?.length > 0) {
            builder.addLineChart(
                chartData.ancestorRatio.labels,
                chartData.ancestorRatio.values,
                {
                    title: '区块内交易数 / 最大祖先高度',
                    label: '比值',
                    borderColor: 'rgb(155, 89, 182)',
                    backgroundColor: 'rgba(155, 89, 182, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    xLabel: '区块高度',
                    yLabel: '比值'
                }
            );
        }

        const htmlPath = builder
            .setTitle(`${ANALYZER_INFO.name}报告 (${startHeight}-${endHeight})`)
            .save(`tx-count_${startHeight}_${endHeight}_${Date.now()}.html`, config.outputDir || './reports');

        reporter.log(`\n📄 HTML 报告已保存: ${htmlPath}`);
        result.htmlPath = htmlPath;
    }

    return result;
}

async function analyzeSv2Log(config = {}, reporter = new Reporter({ silent: config.silent })) {
    const filePath = config.sv2LogFile;
    const records = loadSv2Log(filePath);
    if (records.length === 0) {
        throw new Error(`日志文件没有可解析的 SV2PERF 记录: ${filePath}`);
    }

    const analysis = buildSv2LogAnalysis(records);

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析模式', 'SV2 日志');
    reporter.kv('日志文件', filePath);
    reporter.kv('可解析记录', records.length);
    reporter.kv('创建模板记录', analysis.create.length);
    reporter.kv('验证记录', analysis.submit.length);
    reporter.kv('创建 cs_main 记录', analysis.createCsMain.length);

    if (analysis.warnings.length > 0) {
        reporter.section('提示');
        analysis.warnings.forEach(w => reporter.log(`- ${w}`));
    }

    const createUs = analysis.create.map(r => r.totalUs).filter(v => v != null);
    const createSize = analysis.create.map(r => r.totalSize).filter(v => v != null);
    const createCsMain = analysis.createCsMain.map(r => r.csMainUs).filter(v => v != null);
    const submitUs = analysis.submit.map(r => r.processNewBlockUs).filter(v => v != null);
    const submitSize = analysis.submit.map(r => r.totalSize).filter(v => v != null);
    const intervalRatio = analysis.intervalSeries.map(r => r.y);

    reporter.section('统计结果');
    if (createUs.length) reporter.kv('创建模板耗时均值(us)', analyze(createUs).mean.toFixed(2));
    if (createSize.length) reporter.kv('创建模板总大小均值(bytes)', analyze(createSize).mean.toFixed(2));
    if (createCsMain.length) reporter.kv('创建模板 cs_main 均值(us)', analyze(createCsMain).mean.toFixed(2));
    if (submitUs.length) reporter.kv('验证/提交耗时均值(us)', analyze(submitUs).mean.toFixed(2));
    if (submitSize.length) reporter.kv('验证模板总大小均值(bytes)', analyze(submitSize).mean.toFixed(2));
    if (intervalRatio.length) reporter.kv('相邻高度区间 cs_main 占用比均值', analyze(intervalRatio).mean.toFixed(6));

    const result = {
        info: ANALYZER_INFO,
        config: { mode: 'sv2-log', sv2LogFile: filePath },
        data: {
            mode: 'sv2-log',
            records,
            analysis,
            chartData: {
                mode: 'sv2-log',
                createTotalUs: analysis.series.createTotalUs,
                createTotalSize: analysis.series.createTotalSize,
                createCsMainUs: analysis.series.createCsMainUs,
                submitProcessUs: analysis.series.submitProcessUs,
                submitTotalSize: analysis.series.submitTotalSize,
                intervalOccupancy: analysis.series.intervalOccupancy
            }
        }
    };

    if (config.chart) {
        reporter.section('SV2 关系图');
        new LineChart(80, 12).draw(analysis.series.createTotalUs.values, analysis.series.createTotalUs.labels, {
            pointChar: '●',
            yRange: { min: 0 }
        }).print('创建模板耗时 vs 交易数量');
        new LineChart(80, 12).draw(analysis.series.createTotalSize.values, analysis.series.createTotalSize.labels, {
            pointChar: '●',
            yRange: { min: 0 }
        }).print('创建模板总大小 vs 交易数量');
        new LineChart(80, 12).draw(analysis.series.createCsMainUs.values, analysis.series.createCsMainUs.labels, {
            pointChar: '●',
            yRange: { min: 0 }
        }).print('创建模板 cs_main vs 交易数量');
        new LineChart(80, 12).draw(analysis.series.submitProcessUs.values, analysis.series.submitProcessUs.labels, {
            pointChar: '●',
            yRange: { min: 0 }
        }).print('验证/提交耗时 vs 交易数量');
        if (analysis.series.intervalOccupancy.values.length > 0) {
            new LineChart(80, 12).draw(analysis.series.intervalOccupancy.values, analysis.series.intervalOccupancy.labels, {
                pointChar: '●',
                yRange: { min: 0 }
            }).print('相邻高度区间 cs_main 占用比');
        }
    }

    if (config.html) {
        const builder = new HTMLChartBuilder();
        buildSv2Html(builder, analysis, ANALYZER_INFO.name);
        const htmlPath = builder
            .setTitle(`${ANALYZER_INFO.name}报告`)
            .save(`tx-count_sv2_${Date.now()}.html`, config.outputDir || './reports');
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
            case '--concurrency':
            case '-c':
                config.concurrency = parseInt(args[++i]);
                break;
            case '--ancestor-ratio':
            case '-A':
                config.ancestorRatio = true;
                break;
            case '--sv2-log':
            case '-L':
                config.sv2LogFile = args[++i];
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
    console.log(`  node ${__filename} --ancestor-ratio --html --chart`);
    console.log(`  node ${__filename} --sv2-log /path/to/bitcoind.log --html --chart`);
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
