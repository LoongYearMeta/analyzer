/**
 * 分析器: Pool 出块记录分析 (PoolSolutions)
 *
 * 读取 pool 导出的 NDJSON 文件（pool-solutions.ndjson），每行一条出块记录。
 * Pool 字段（见 message_handler.rs::append_block_record）:
 *   pool_submit_time  — 上块时间（KEY，pool 判定解满足网络难度的时刻）
 *                       新格式(c6d11dc 起): Unix 纪元毫秒整数；旧格式: ISO 8601 字符串。两者皆兼容。
 *   header_timestamp  — 区块头 nTime（Unix 秒，UTC）
 *   utc_e2            — 矿机开挖该 job 的时间。
 *                       新格式: Unix 纪元毫秒整数（pool 已由 6 字节大端解码）；旧格式: 6 字节大端 hex 串。兼容。
 *   extranonce1       — 矿机标识符（hex 18B）
 *   block_height      — 区块高度（BIP34 coinbase 解码）
 *   block_hash        — 区块 hash（BE hex，check_target 计算所得）
 *   prev_hash         — 前一区块 hash（BE hex），用于多解竞争时定位胜出解
 *   pool_signature    — 从 coinbase scriptSig 还原的 pool 标识串
 *   nbits/nonce/version/job_id/channel_id/template_id
 *
 * 产出:
 *   - 控制台: 记录表（标识多解/胜出/孤块/异常）+ 统计摘要
 *   - HTML 报告（--html）:
 *       图1 难度折线图（高度 → 网络难度，Y 轴自适应放大波动，紧凑刻度）
 *       图2 出块间隔散点图（pool_submit_time 时钟，仅胜出链）
 *       图3 时间源一致性图（同一秒轴：找块耗时 submit−e2、header−e2 偏移，差异仅秒级·受 header 整秒精度影响）
 *       图4 出块间隔分布直方图（含 PoW 指数分布参考曲线）
 *       异常判定说明（公式可迭代）
 *
 * 独立运行:
 *   node analyzers/pool-solutions.js [--file pool-solutions.ndjson] [--html] [--json] [--csv]
 */

const fs   = require('fs');
const path = require('path');
const { analyze } = require('../lib/stats');
const { HTMLChartBuilder } = require('../lib/charts');

// ============ 分析器信息 ============
const ANALYZER_INFO = {
    id: 'pool-solutions',
    name: 'Pool 出块记录分析',
    description: '读取 pool 导出的 NDJSON，标识多解、绘制难度/出块间隔/时间源重合/间隔分布图',
    icon: '⛏️',
    version: '3.0.0',
    options: [
        { name: 'file', alias: 'f', type: 'string',  description: 'NDJSON 文件路径', default: 'pool-solutions.ndjson' },
        { name: 'html', type: 'boolean', description: '生成 HTML 报告', default: false },
        { name: 'json', type: 'boolean', description: '输出 JSON 文件', default: false },
        { name: 'csv',  type: 'boolean', description: '输出 CSV 文件',  default: false },
        { name: 'out',  type: 'string',  description: '输出目录',       default: './reports' },
    ]
};

// ============ nBits → difficulty ============
// difficulty = difficulty1_target / nbits_target，使用 BigInt 保精度。
const DIFF1 = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

function nbits_to_difficulty(nbits) {
    if (!nbits) return null;
    const exp = (nbits >>> 24) & 0xff;
    const mantissa = nbits & 0xffffff;
    if (mantissa === 0) return null;
    const shift = 8 * (exp - 3);
    let target = shift >= 0 ? BigInt(mantissa) << BigInt(shift) : BigInt(mantissa) >> BigInt(-shift);
    if (target === 0n) return null;
    const diff_scaled = (DIFF1 * 1_000_000n) / target;
    return Number(diff_scaled) / 1_000_000;
}

// ============ utc_e2 解码（6 字节 UTC 毫秒）============
const E2_MIN_MS = 1577836800000n;  // 2020-01-01
const E2_MAX_MS = 2208988800000n;  // 2040-01-01

function decodeUtcE2(hexStr) {
    if (!hexStr || hexStr.length !== 12) return null;
    let val = 0n;
    for (let i = 0; i < 12; i += 2) {
        val = (val << 8n) | BigInt(parseInt(hexStr.slice(i, i + 2), 16));
    }
    if (val < E2_MIN_MS || val > E2_MAX_MS) return null;
    return Number(val);
}

// pool_submit_time → epoch ms。新格式=毫秒整数；旧格式=ISO 字符串。
function parseSubmitMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const t = Date.parse(v);                 // ISO 字符串（旧格式）
    return Number.isNaN(t) ? null : t;
}

// utc_e2 → epoch ms。新格式=毫秒整数（pool 已解码）；旧格式=6 字节大端 hex 串。
// 两种格式都做 2020–2040 合理性校验，过滤掉随机 extranonce2（非时间）产生的垃圾值。
function parseE2Ms(v) {
    if (v == null) return null;
    if (typeof v === 'number') {
        const b = BigInt(Math.trunc(v));
        return (b >= E2_MIN_MS && b <= E2_MAX_MS) ? v : null;
    }
    if (typeof v === 'string') return decodeUtcE2(v);
    return null;
}

// hash 归一化：去掉 0x 前缀、转小写，便于 block_hash 与 prev_hash 比较
function normHash(h) {
    if (!h) return null;
    return h.toLowerCase().replace(/^0x/, '');
}

// ============ 与 BTC 泊松出块的偏离量化 ============
//
// BTC 出块目标 600s，间隔服从指数分布 Exp(λ=1/600)，CDF F(t)=1−e^(−t/600)。
const BTC_TARGET_S = 600;

// Kolmogorov–Smirnov 距离：经验分布与指数分布 Exp(λ) 的最大 CDF 偏差 D∈[0,1]。
function ksDistanceExp(sortedAsc, lambda) {
    const N = sortedAsc.length;
    if (N === 0) return 0;
    let d = 0;
    for (let i = 0; i < N; i++) {
        const F = 1 - Math.exp(-lambda * sortedAsc[i]);   // 理论 CDF
        d = Math.max(d, Math.abs(F - i / N), Math.abs(F - (i + 1) / N));
    }
    return d;
}

// 综合量化"和正常 BTC 出块的差异"：
//   cv         变异系数 σ/μ，指数分布理论值 = 1（形状指标）
//   speedRatio 600/μ，>1 表示比 BTC 快几倍（节奏指标）
//   ksBtc      与 BTC Exp(1/600) 的 KS 距离（节奏+形状综合偏离，参数完全指定，检验严格）
//   ksSelf     与自身 Exp(1/μ) 的 KS 距离（纯形状偏离，即是否为泊松；μ 由数据估计，偏保守）
//   ksCrit     α=0.05 KS 临界值 1.36/√N，D 超过即显著偏离
function quantifyDeviation(validIntervals, stats) {
    const N = validIntervals.length;
    const mu = stats.mean, sigma = stats.stdDev;
    const cv = mu > 0 ? sigma / mu : 0;
    const speedRatio = mu > 0 ? BTC_TARGET_S / mu : 0;
    const sorted = [...validIntervals].sort((a, b) => a - b);
    const ksBtc = ksDistanceExp(sorted, 1 / BTC_TARGET_S);
    const ksSelf = mu > 0 ? ksDistanceExp(sorted, 1 / mu) : 0;
    const ksCrit = N > 0 ? 1.36 / Math.sqrt(N) : Infinity;
    return { N, mu, sigma, cv, speedRatio, ksBtc, ksSelf, ksCrit };
}

// ============ 数据加载 ============

function loadRecords(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`NDJSON 文件不存在: ${filePath}\n请先运行 pool（会自动写入 pool-solutions.ndjson）`);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());

    return lines.map((line, idx) => {
        let e;
        try { e = JSON.parse(line); }
        catch { console.error(`第 ${idx + 1} 行 JSON 解析失败: ${line}`); return null; }

        const pool_submit_ms = parseSubmitMs(e.pool_submit_time);
        const e2_ms          = parseE2Ms(e.utc_e2);
        const header_ms      = e.header_timestamp != null ? e.header_timestamp * 1000 : null;

        // 找块时间 = 上块时间 − 矿机开挖时间（秒）
        const finding_s = (pool_submit_ms != null && e2_ms != null)
            ? (pool_submit_ms - e2_ms) / 1000 : null;
        // header 相对 e2 起挖时间的偏移（秒）；≈0 表示 header 在开挖时设定、与 e2 重合。
        // header_timestamp 只有整秒精度，必须把 e2 也截断到整秒再比较——否则 ms 值减整秒会产生
        // 亚秒级假负值（如 header=...651s 减 e2=...651.607s = −0.607s，纯属精度不对齐）。
        const header_off_s = (e.header_timestamp != null && e2_ms != null)
            ? e.header_timestamp - Math.floor(e2_ms / 1000) : null;

        return {
            idx: idx + 1,
            pool_submit_time: e.pool_submit_time ?? null,
            pool_submit_ms,
            pool_submit_iso: pool_submit_ms != null ? new Date(pool_submit_ms).toISOString() : null,
            utc_e2: e.utc_e2 ?? null,
            e2_ms,
            e2_iso: e2_ms != null ? new Date(e2_ms).toISOString() : null,
            header_timestamp: e.header_timestamp ?? null,
            header_ms,
            header_iso: header_ms != null ? new Date(header_ms).toISOString() : null,
            extranonce1: e.extranonce1 ?? null,
            block_height: e.block_height ?? null,
            block_hash: e.block_hash ?? null,
            prev_hash: e.prev_hash ?? null,
            pool_signature: e.pool_signature ?? null,
            nbits: e.nbits ?? null,
            difficulty: nbits_to_difficulty(e.nbits),
            nonce: e.nonce ?? null,
            version: e.version ?? null,
            job_id: e.job_id ?? null,
            channel_id: e.channel_id ?? null,
            template_id: e.template_id ?? null,
            finding_s,
            header_off_s,
        };
    }).filter(Boolean);
}

// ============ 多解检测 + 胜出解判定 ============
//
// 同一 block_height 出现多条记录 = 多解竞争。
// 胜出解判定：下一高度(H+1)记录的 prev_hash 指向 H 高度真正被接续的区块，
// 因此 H 高度中 block_hash == (H+1).prev_hash 的那条即胜出解，其余为孤块/落败解。
function detectSolutions(records) {
    const byHeight = new Map();
    for (const r of records) {
        if (r.block_height == null) continue;
        if (!byHeight.has(r.block_height)) byHeight.set(r.block_height, []);
        byHeight.get(r.block_height).push(r);
    }

    for (const [h, group] of byHeight) {
        const next = byHeight.get(h + 1);
        const winnerHashes = next
            ? new Set(next.map(n => normHash(n.prev_hash)).filter(Boolean))
            : null;

        for (const r of group) {
            r.solutionCount = group.length;
            r.isMultiSolution = group.length > 1;
            if (winnerHashes) {
                r.isWinner = winnerHashes.has(normHash(r.block_hash));
                r.isOrphan = !r.isWinner;
                r.winnerKnown = true;
            } else {
                // 最新高度尚无后续块可佐证：单解默认视为胜出，多解标为未决
                r.winnerKnown = group.length === 1;
                r.isWinner = group.length === 1;
                r.isOrphan = false;
            }
        }
    }
    return byHeight;
}

// ============ 胜出链 + 出块间隔 ============
//
// 取每个高度的胜出解，按高度排序，用 pool_submit_ms 计算相邻间隔。
function buildChain(byHeight) {
    const winners = [];
    for (const [h, group] of byHeight) {
        let w = group.find(r => r.isWinner);
        if (!w && group.length === 1) w = group[0];
        if (!w) w = group.slice().sort((a, b) => (a.pool_submit_ms || 0) - (b.pool_submit_ms || 0))[0]; // 未决：取最早提交
        winners.push(w);
    }
    winners.sort((a, b) => a.block_height - b.block_height);

    const chain = [];
    for (let i = 0; i < winners.length; i++) {
        const w = winners[i];
        const prev = winners[i - 1];
        let interval_s = null;
        if (prev && w.pool_submit_ms != null && prev.pool_submit_ms != null
            && w.block_height === prev.block_height + 1) {
            interval_s = (w.pool_submit_ms - prev.pool_submit_ms) / 1000;
        }
        chain.push({ ...w, interval_s });
    }
    return chain;
}

// ============ 异常判定（基线公式，可迭代）============
//
// PoW 出块是泊松过程，间隔服从指数分布，生存函数 P(T>t)=e^(−t/μ)。
// 以下为起步规则，阈值/方法后续可按需调整：
//   1) 间隔重复/乱序: interval ≤ 0
//   2) 间隔长尾异常 : P(T>t) < 0.01，即 t > μ·ln(100) ≈ 4.6μ
//   3) 找块时间异常 : finding_s < 0（时钟回拨/编码错误）
//   4) 时间源不一致 : |header_off_s| > 120s（header 与 e2 起挖时间应当接近）
function flagAnomalies(chain, mu) {
    const TOL_HEADER_S = 120;
    const tailThreshold = mu > 0 ? mu * Math.log(100) : Infinity; // P<0.01
    for (const r of chain) {
        const flags = [];
        if (r.interval_s != null && r.interval_s <= 0) flags.push('间隔≤0(重复/乱序)');
        if (r.interval_s != null && r.interval_s > tailThreshold) flags.push('间隔长尾(P<1%)');
        if (r.finding_s != null && r.finding_s < 0) flags.push('找块时间<0(时钟/编码)');
        if (r.header_off_s != null && Math.abs(r.header_off_s) > TOL_HEADER_S) flags.push('header与e2偏移大');
        r.anomalies = flags;
    }
    return chain;
}

// ============ 核心分析 ============

function analyzePoolSolutions(config = {}) {
    const filePath = config.file || 'pool-solutions.ndjson';

    console.log(`\n📋 ${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    console.log(`   数据来源: ${filePath}\n`);

    const records = loadRecords(filePath);
    if (records.length === 0) {
        console.log('  (文件为空，尚无出块记录)');
        return { info: ANALYZER_INFO, records: [] };
    }

    const byHeight = detectSolutions(records);
    const chain = buildChain(byHeight);

    // 出块间隔统计（仅有效正间隔）
    const intervals = chain.map(c => c.interval_s).filter(v => v != null);
    const validIntervals = intervals.filter(v => v > 0);
    const stats = analyze(validIntervals);
    const mu = stats.mean || 0;
    flagAnomalies(chain, mu);

    // 多解统计
    const multiHeights = [...byHeight.entries()].filter(([, g]) => g.length > 1);

    // ---- 控制台输出 ----
    // 与 BTC 泊松出块的偏离量化
    const dev = validIntervals.length >= 2 ? quantifyDeviation(validIntervals, stats) : null;

    console.log(`   记录数: ${records.length} | 高度数: ${byHeight.size} | 多解高度: ${multiHeights.length}`);
    if (validIntervals.length > 0) {
        console.log(`   出块间隔(胜出链): 均值 ${mu.toFixed(1)}s | 中位 ${stats.median.toFixed(1)}s | p99 ${stats.p99.toFixed(1)}s | min ${stats.min}s | max ${stats.max}s`);
    }
    if (dev) {
        const verdict = dev.ksBtc > dev.ksCrit ? '显著偏离' : '不拒绝';
        console.log(`   与BTC偏离: CV=${dev.cv.toFixed(2)}(指数理论1.0) | 速度=BTC的${dev.speedRatio.toFixed(2)}倍 | KS_vs_BTC=${dev.ksBtc.toFixed(3)}(临界${dev.ksCrit.toFixed(3)}→${verdict}) | KS_vs_自身指数=${dev.ksSelf.toFixed(3)}`);
    }
    const findings = chain.map(c => c.finding_s).filter(v => v != null);
    if (findings.length) {
        const fs2 = analyze(findings);
        console.log(`   找块时间(submit−e2): 均值 ${fs2.mean.toFixed(1)}s | 中位 ${fs2.median.toFixed(1)}s | min ${fs2.min.toFixed(1)}s | max ${fs2.max.toFixed(1)}s`);
    }
    console.log('');
    printTable(chain);

    if (multiHeights.length) {
        console.log(`\n⚔️  多解竞争高度:`);
        for (const [h, group] of multiHeights) {
            console.log(`   高度 ${h} (${group.length} 解):`);
            for (const r of group) {
                const tag = r.isWinner ? '✅胜出' : (r.winnerKnown ? '⛔孤块' : '❔未决');
                console.log(`     ${tag} hash=…${(normHash(r.block_hash) || '').slice(-16)} submit=${r.pool_submit_iso} ch=${r.channel_id}`);
            }
        }
    }

    const anomalies = chain.filter(c => c.anomalies && c.anomalies.length);
    if (anomalies.length) {
        console.log(`\n⚠️  异常记录 (${anomalies.length}):`);
        for (const r of anomalies) {
            console.log(`   高度 ${r.block_height}: ${r.anomalies.join(', ')}`);
        }
    }

    // ---- 文件输出 ----
    const outDir = config.out || './reports';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const stamp = Date.now();

    if (config.json) {
        const p = path.join(outDir, `pool-solutions_${stamp}.json`);
        fs.writeFileSync(p, JSON.stringify(records, null, 2));
        console.log(`\n📄 JSON: ${p}`);
    }
    if (config.csv) {
        const p = path.join(outDir, `pool-solutions_${stamp}.csv`);
        fs.writeFileSync(p, toCSV(records));
        console.log(`📄 CSV : ${p}`);
    }
    if (config.html) {
        const p = buildHTML(records, chain, byHeight, stats, mu, dev, outDir);
        console.log(`\n📄 HTML 报告: ${p}`);
    }

    return { info: ANALYZER_INFO, records, chain, byHeight, stats };
}

// ============ 控制台表格 ============

function printTable(chain) {
    if (!chain.length) { console.log('  (无记录)'); return; }

    const cols = [
        { key: 'block_height', label: '高度',        width: 8  },
        { key: 'pool_submit_iso', label: '上块时间(UTC)', width: 26 },
        { key: 'interval_s',   label: '间隔s',       width: 8, fmt: v => v == null ? '-' : v.toFixed(0) },
        { key: 'finding_s',    label: '找块s',       width: 8, fmt: v => v == null ? '-' : v.toFixed(0) },
        { key: 'header_off_s', label: 'hdr偏移s',    width: 9, fmt: v => v == null ? '-' : v.toFixed(0) },
        { key: 'difficulty',   label: '难度',        width: 14, fmt: v => v == null ? '-' : v.toLocaleString(undefined, {maximumFractionDigits: 2}) },
        { key: 'solutionCount',label: '解数',        width: 5  },
        { key: '_status',      label: '状态',        width: 8  },
        { key: 'block_hash',   label: 'hash尾16',    width: 18, fmt: v => { const n = normHash(v); return n ? '…' + n.slice(-16) : '-'; } },
    ];

    const sep = cols.map(c => '-'.repeat(c.width + 2)).join('+');
    const hdr = cols.map(c => ` ${c.label.padEnd(c.width)} `).join('|');
    console.log(`+${sep}+`);
    console.log(`|${hdr}|`);
    console.log(`+${sep}+`);

    for (const r of chain) {
        const status = r.isMultiSolution
            ? (r.isWinner ? '多解✅' : (r.winnerKnown ? '多解⛔' : '多解❔'))
            : '单解';
        const view = { ...r, _status: status };
        const row = cols.map(c => {
            const v = view[c.key];
            const s = (v === null || v === undefined) ? '-' : (c.fmt ? c.fmt(v) : String(v));
            return ` ${s.slice(0, c.width).padEnd(c.width)} `;
        }).join('|');
        console.log(`|${row}|`);
        if (r.anomalies && r.anomalies.length) {
            console.log(`|  ⚠️  ${r.anomalies.join(', ')}`);
        }
    }
    console.log(`+${sep}+`);
}

// ============ CSV ============

function toCSV(records) {
    const headers = [
        'idx','block_height','pool_submit_time','pool_submit_iso',
        'utc_e2','e2_iso','header_timestamp','header_iso',
        'finding_s','header_off_s',
        'extranonce1','block_hash','prev_hash','pool_signature',
        'nbits','difficulty','nonce','version',
        'job_id','channel_id','template_id',
        'solutionCount','isWinner','isOrphan',
    ];
    const rows = records.map(r =>
        headers.map(h => {
            const v = r[h];
            if (v === null || v === undefined) return '';
            const s = String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')
    );
    return [headers.join(','), ...rows].join('\n');
}

// ============ HTML 报告 ============

function buildHTML(records, chain, byHeight, stats, mu, dev, outDir) {
    const builder = new HTMLChartBuilder();

    // ---- 图1 难度变化图（折线连接 + 小点；Y 轴缩放到数据范围放大波动；隐藏 Y 轴数字，悬停看精确值）----
    const diffPts = chain.filter(c => c.difficulty != null);
    builder.addLineChart(
        diffPts.map(c => `#${c.block_height}`),
        diffPts.map(c => c.difficulty),
        { title: '网络难度变化（由 nbits 还原）', xLabel: '区块高度', yLabel: '难度',
          label: '网络难度', pointRadius: 2, beginAtZero: false,
          caption: '每个点 = 一个区块由其 <b>nbits</b> 还原出的网络难度，折线按高度顺序连接看趋势。'
                 + 'Y 轴<b>缩放到数据范围</b>（不从 0 起），把这段高度内 ~3.4M~3.6M 的细微难度调整放大出来；'
                 + '点上不再叠加数字，<b>悬停某点即显示该块的精确难度值</b>。' }
    );

    // ---- 图2 出块间隔散点图（pool_submit_time 时钟）----
    const ivPts = chain.filter(c => c.interval_s != null && c.pool_submit_ms != null);
    if (ivPts.length) {
        const logYMin = parseFloat((Math.min(...ivPts.map(p => p.interval_s).filter(v => v > 0), 60) / 60 * 0.5).toFixed(4));
        builder.addScatterTimeChart(
            ivPts.map(c => ({
                x: Math.floor(c.pool_submit_ms / 1000),
                y: c.interval_s > 0 ? c.interval_s / 60 : logYMin,
                height: c.block_height,
                interval: c.interval_s,
                zero: c.interval_s <= 0,
            })),
            {
                title: '出块间隔散点图（pool 上块时间为时钟，仅胜出链）',
                avgLine: mu / 60,
                avgLabel: `平均间隔 ${mu.toFixed(1)}s`,
                avgColor: '#27ae60',
                xLabel: '上块时间', yLabel: '间隔 (m)',
                useLogScale: true, yMin: logYMin,
                colorFn: (d) => d.interval <= 0 ? '#e74c3c'
                    : d.interval < mu * 0.5 ? '#27ae60'
                    : d.interval < mu * 1.2 ? '#3498db'
                    : d.interval < mu * 2.0 ? '#f39c12' : '#e74c3c',
            }
        );
    }

    // ---- 图3 时间源一致性（同一根秒轴：三个时间戳本应描述同一出块时刻，差异只在秒级）----
    const tPts = chain.filter(c => c.finding_s != null || c.header_off_s != null);
    if (tPts.length) {
        builder.addMultiLineChart(
            tPts.map(c => `#${c.block_height}`),
            [
                { label: '找块耗时 submit−e2 (s)', data: tPts.map(c => c.finding_s != null ? +c.finding_s.toFixed(2) : null), color: '#3498db' },
                { label: 'header−e2 偏移 (s)',    data: tPts.map(c => c.header_off_s != null ? +c.header_off_s.toFixed(2) : null), color: '#e74c3c', dash: [5, 3] },
            ],
            { title: '时间源一致性（三个时间戳的相互偏差，单位：秒）', xLabel: '区块高度', yLabel: '秒',
              caption: '同一个区块有三个时间戳，理想下都指向"出块那一刻"，相互只差几秒：'
                     + '<br>· <b>pool_submit_time</b>（毫秒）= pool 收到并验证胜出解的墙钟时刻'
                     + '<br>· <b>utc_e2</b>（毫秒）= 矿机开挖该 job 时编码进 extranonce2 的时刻'
                     + '<br>· <b>header_timestamp</b>（<b>整秒</b>）= 区块头 nTime'
                     + '<br><span style="color:#3498db"><b>蓝线 找块耗时 = submit − e2</b></span>：从开挖到 pool 接受解的耗时（本数据约 1~2.5s）。'
                     + '<span style="color:#e74c3c"><b>红虚线 header−e2</b></span>：区块头与开挖时刻之差（本数据约 −1~+5s）。'
                     + '<br>两条线量级相同、都贴近 0~数秒。<b>header−e2 已按整秒对齐计算</b>'
                     + '（header 本就是整秒，故把 e2 也截断到整秒再相减），因此是 0、1、2… 的整数秒偏移，'
                     + '<b>不会再出现亚秒级假负值</b>。只有当某点突然跳到几十秒以上，才说明时间源构造异常。' }
        );
    }

    // ---- 图4 出块间隔分布直方图（指数分布参考）----
    const validIv = chain.map(c => c.interval_s).filter(v => v != null && v > 0);
    if (validIv.length >= 2) {
        const sigma = stats.stdDev;
        const sorted = [...validIv].sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        const fdWidth = 2 * iqr * Math.pow(validIv.length, -1 / 3);
        const binWidth = Math.max(5, Math.round(fdWidth || 5));
        const numBins = Math.max(1, Math.ceil((stats.p99 || stats.max) / binWidth));
        const outlierMin = numBins * binWidth;

        const labels = [], counts = [], colors = [], selfExpCurve = [], btcExpCurve = [], binRanges = [];
        const lambdaSelf = mu > 0 ? 1 / mu : 0;          // 实测自身指数 Exp(1/μ)（形状参考）
        const lambdaBtc  = 1 / BTC_TARGET_S;             // BTC 泊松参考 Exp(1/600)

        for (let i = 0; i < numBins; i++) {
            const bMin = i * binWidth, bMax = (i + 1) * binWidth, c = bMin + binWidth / 2;
            const count = validIv.filter(v => v >= bMin && v < bMax).length;
            labels.push(i % 5 === 0 ? `${bMin}s` : '');
            counts.push(count);
            colors.push(c < mu * 0.5 ? '#27ae60' : c < mu * 1.5 ? '#3498db' : '#e74c3c');
            binRanges.push({ min: bMin, max: bMax });
            // 期望频次 = N · binWidth · pdf(c)
            const pdfSelf = lambdaSelf * Math.exp(-lambdaSelf * c);
            selfExpCurve.push(+(pdfSelf * validIv.length * binWidth).toFixed(2));
            const pdfBtc = lambdaBtc * Math.exp(-lambdaBtc * c);
            btcExpCurve.push(+(pdfBtc * validIv.length * binWidth).toFixed(2));
        }
        const outlierCount = validIv.filter(v => v >= outlierMin).length;
        if (outlierCount > 0) {
            labels.push(`>${outlierMin}s`); counts.push(outlierCount); colors.push('#e74c3c');
            selfExpCurve.push(0); btcExpCurve.push(0); binRanges.push({ min: outlierMin, max: Infinity });
        }

        // normalCurve  → 实测自身指数拟合 Exp(1/μ)
        // normalCurve2 → BTC 泊松参考 Exp(1/600)
        builder.addBarChart(labels, counts, {
            title: '出块间隔分布（实测指数拟合 vs BTC 泊松参考 λ=1/600）',
            xLabel: '间隔时间', yLabel: '频次',
            colors,
            normalCurve: selfExpCurve, normalCurveLabel: `实测指数拟合 λ=1/μ (μ=${mu.toFixed(0)}s)`,
            normalCurve2: btcExpCurve, normalCurve2Label: 'BTC 泊松参考 λ=1/600',
            binRanges, totalCount: validIv.length,
        });
    }

    // ---- 与 BTC 泊松出块的偏离量化 ----
    if (dev) {
        const ksVerdict = dev.ksBtc > dev.ksCrit
            ? `<strong style="color:#e74c3c">D &gt; 临界值 → 与 BTC 指数分布显著不同</strong>`
            : `<strong style="color:#27ae60">D ≤ 临界值 → 不能拒绝"与 BTC 一致"</strong>`;
        const cvVerdict = Math.abs(dev.cv - 1) < 0.2 ? '接近 1，形状像指数分布'
            : dev.cv > 1 ? '＞1，长尾偏重（间隔波动比指数更大）'
            : '＜1，过于规整（比自由竞争出块更均匀）';
        const speedTxt = dev.speedRatio >= 1
            ? `比 BTC 快 ${dev.speedRatio.toFixed(2)} 倍` : `比 BTC 慢 ${(1 / dev.speedRatio).toFixed(2)} 倍`;
        builder.addNote(`
            <h3>与正常 BTC 出块的偏离量化</h3>
            <p>BTC 出块目标 600s，间隔服从泊松过程的指数分布 Exp(λ=1/600)。下列指标量化本链与之的差异
               （样本 N=${dev.N}${dev.N < 100 ? '，<span style="color:#e67e22">样本偏少，分布形状结论仅供参考</span>' : ''}）：</p>
            <table>
                <tr><th>指标</th><th>数值</th><th>含义 / 判读</th></tr>
                <tr><td>实测均值 μ</td><td>${dev.mu.toFixed(1)}s（${(dev.mu / 60).toFixed(2)}m）</td><td>${speedTxt}（节奏差异）</td></tr>
                <tr><td>变异系数 CV=σ/μ</td><td>${dev.cv.toFixed(3)}</td><td>指数分布理论值=1；本值${cvVerdict}（形状差异）</td></tr>
                <tr><td>KS 距离 vs BTC Exp(1/600)</td><td>${dev.ksBtc.toFixed(3)}</td><td>临界值 1.36/√N=${dev.ksCrit.toFixed(3)}；${ksVerdict}</td></tr>
                <tr><td>KS 距离 vs 自身 Exp(1/μ)</td><td>${dev.ksSelf.toFixed(3)}</td><td>纯形状偏离：是否为泊松过程（越小越像）</td></tr>
            </table>
            <p style="font-size:13px;color:#666;">
                读图：图4 紫色虚线是 <strong>BTC 泊松参考（λ=1/600）</strong>，红色实线是<strong>本链自身指数拟合（λ=1/μ）</strong>。
                若柱状图贴合红线但远离紫线 → 形状是健康泊松、只是节奏与 BTC 不同（μ≠600）；
                若柱状图连红线都不贴 → 出块过程本身非泊松（CV、KS_自身会同步偏大）。
            </p>`);
    }

    // ---- 异常判定说明 ----
    const multiCount = [...byHeight.values()].filter(g => g.length > 1).length;
    const anomalyCount = chain.filter(c => c.anomalies && c.anomalies.length).length;
    builder.addNote(`
        <h3>出块时间异常判定（基线公式，可迭代）</h3>
        <p>PoW 出块是泊松过程，相邻出块间隔服从<strong>指数分布</strong>，生存函数
           <span style="font-family:monospace;background:#eef;padding:2px 8px;border-radius:4px;">P(T&gt;t)=e<sup>−t/μ</sup></span>，
           本数据实测均值 μ = <strong>${mu.toFixed(1)}s</strong>。当前采用的判定规则：</p>
        <table>
            <tr><th>类别</th><th>判定条件</th><th>含义</th></tr>
            <tr><td>间隔重复/乱序</td><td>interval ≤ 0</td><td>同一时刻多次提交或记录乱序</td></tr>
            <tr><td>间隔长尾</td><td>P(T&gt;t) &lt; 1%，即 t &gt; μ·ln(100) ≈ ${(mu * Math.log(100)).toFixed(0)}s</td><td>异常长的出块等待，可能算力骤降/难度滞后</td></tr>
            <tr><td>找块时间异常</td><td>submit−e2 &lt; 0</td><td>上块时间早于开挖时间 → 时钟回拨或 e2 编码错误</td></tr>
            <tr><td>时间源不一致</td><td>|header−e2| &gt; 120s</td><td>区块头 nTime 与 extranonce2 起挖时间偏离过大</td></tr>
        </table>
        <p>统计：高度 ${byHeight.size} 个，多解竞争 ${multiCount} 处，命中异常 ${anomalyCount} 条。</p>
        <h3>三时间源说明（图3 读法）</h3>
        <p>每个解涉及三个时间：<strong>pool_submit_time</strong>（pool 收到并验证解的墙钟时刻，毫秒）、
           <strong>utc_e2</strong>（矿机编码进 extranonce2 的开挖时刻，毫秒）、
           <strong>header_timestamp</strong>（区块头 nTime，<strong>整秒</strong>）。
           三者本应描述<strong>同一个出块时刻</strong>，差异只在秒级，故同绘于一根"秒"轴上：</p>
        <ul>
            <li><strong style="color:#3498db">蓝线 找块耗时 submit−e2</strong>：从开挖到 pool 接受解的耗时，应为正、数秒量级；
                出现明显负值才是"找块时间异常"（时钟回拨 / e2 编码错误）。</li>
            <li><strong style="color:#e74c3c">红虚线 header−e2 偏移</strong>：区块头 nTime 与开挖时刻之差，应贴近 0。
                <strong>计算口径</strong>：header 只有整秒精度，因此把 e2 也截断到整秒再相减（<code>header − floor(e2)</code>），
                得到的是整数秒偏移，<strong>不会出现毫秒级假负值</strong>。只有持续偏离到几十秒以上才说明时间源构造有问题。</li>
        </ul>
        <p style="color:#888;font-size:12px;">※ 两条线量纲相同，可直接比较高低；阈值见上表"时间源不一致 |header−e2|&gt;120s"。</p>
        <p style="color:#888;font-size:12px;">※ 公式与阈值为起步基线，确定正式判据后可在 flagAnomalies() 中调整。</p>
    `);

    // 标题附带高度范围，如「Pool 出块记录分析报告 (836261-836370)」
    const heights = [...byHeight.keys()].filter(h => h != null);
    const titleRange = heights.length ? ` (${Math.min(...heights)}-${Math.max(...heights)})` : '';

    return builder
        .setTitle(`${ANALYZER_INFO.name}报告${titleRange}`)
        .save(`pool-solutions_${Date.now()}.html`, outDir);
}

// ============ 命令行 ============
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {};
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--file': case '-f': config.file = args[++i]; break;
            case '--out':             config.out  = args[++i]; break;
            case '--html':            config.html = true;      break;
            case '--json':            config.json = true;      break;
            case '--csv':             config.csv  = true;      break;
            case '--help': case '-h': printUsage(); process.exit(0);
        }
    }
    return config;
}

function printUsage() {
    console.log(`\n用法: node ${path.basename(__filename)} [选项]`);
    console.log('\n选项:');
    ANALYZER_INFO.options.forEach(o => {
        const def = o.default != null ? ` (默认: ${o.default})` : '';
        console.log(`  ${(o.alias ? `-${o.alias}, ` : '    ')}--${o.name.padEnd(8)} ${o.description}${def}`);
    });
    console.log('\n示例:');
    console.log(`  node ${path.basename(__filename)} --file pool-solutions.ndjson --html`);
}

// ============ 导出和独立运行 ============
module.exports = { info: ANALYZER_INFO, analyze: analyzePoolSolutions };

if (require.main === module) {
    const config = parseArgs();
    try { analyzePoolSolutions(config); }
    catch (err) { console.error('错误:', err.message); process.exit(1); }
}
