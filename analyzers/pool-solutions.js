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
        { name: 'prevhash-file', type: 'string', description: 'prev_hash 时序 NDJSON（默认与 --file 同目录的 pool-prevhash.ndjson）' },
        { name: 'poisson-window', type: 'number', description: '泊松计数图的窗口秒数（默认 3600=每小时出块数）' },
        { name: 'cross-pool', type: 'boolean', description: '显示基于 share 的算力图（"实测网络算力" + "跨池总算力"）；默认隐藏（share 法受 translator vardiff 影响偏低，算力以出块速率反推为准）', default: false },
        { name: 'include-gaps', type: 'boolean', description: '把大缺口(停机/断链)也计入泊松计数 D（默认剔除，仅统计在线期；开启后所有异常数据进入计算）', default: false },
        { name: 'gap-threshold', type: 'number', description: '大缺口阈值秒数，超过即判为停机/断链（默认 max(窗口×3, 3600)）' },
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

function minMax(values) {
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (const v of values) {
        if (v == null || Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        count++;
    }
    return count ? { min, max, count } : null;
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
            hashrate_10min_hs: e.hashrate_10min_hs ?? null,
            hashrate_total_hs: e.hashrate_total_hs ?? null,
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

// ============ prev_hash 传播时序加载（pool-prevhash.ndjson，可选）============
//
// pool 在每次链 tip 变更时记一行：从 TP 收到新 prev_hash 到向矿机下发 SetNewPrevHash
// 的延迟 stale_ms（矿机这段时间在旧 prev_hash 上挖无效工作）。文件不存在则返回空。
function loadPrevhashRecords(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return [];
        const raw = fs.readFileSync(filePath, 'utf8');
        return raw.split('\n').filter(l => l.trim()).map(l => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
}

// ============ canonical 链重建（反向溯链 + 去重 + 排除分叉）============
//
// 设计（支持多池直接拼接，同链由调用方保证）：
//   1) 按 block_hash 去重：同一区块被多个池各记一条 → 只算一个，保留最早 pool_submit_time
//      （最接近真实出块时刻），并累计见过它的 pool_signature 集合；
//   2) 从最高高度沿 prev_hash 一路回溯（prev_hash → 父块 block_hash），得到唯一最长正确链；
//      不在这条链上的块即孤块/分叉，自动排除（多池多分叉也这样被剔掉）；
//   3) 中断标记：若回溯到的链最低高度 > 数据最低高度（中间断链），记下断点；
//   4) 高度-时间反向校验：canonical 链上更高高度的 pool_submit_time 不应早于更低高度，
//      违反即异常（链溯错 / 时钟回拨）——表现为相邻 interval ≤ 0，由 flagAnomalies 标出。
function buildChainView(records) {
    const norm = normHash;

    // 1) 去重：同 block_hash 合并，取最早 pool_submit_ms 的那条，累计 pool_signature
    const byHash = new Map();
    for (const r of records) {
        if (r.block_height == null || !r.block_hash) continue;
        const key = norm(r.block_hash);
        const ex = byHash.get(key);
        if (!ex) {
            byHash.set(key, { ...r, _pools: new Set(r.pool_signature != null ? [r.pool_signature] : []) });
        } else {
            if (r.pool_signature != null) ex._pools.add(r.pool_signature);
            if (r.pool_submit_ms != null && (ex.pool_submit_ms == null || r.pool_submit_ms < ex.pool_submit_ms)) {
                byHash.set(key, { ...r, _pools: ex._pools });
            }
        }
    }
    const unique = [...byHash.values()];

    // 2) 按高度分组（去重后）：同高度多个不同 hash = 真实竞争
    const byHeight = new Map();
    for (const r of unique) {
        if (!byHeight.has(r.block_height)) byHeight.set(r.block_height, []);
        byHeight.get(r.block_height).push(r);
    }
    const pools = new Set();
    for (const r of unique) for (const p of (r._pools || [])) pools.add(p);

    if (unique.length === 0) {
        return { chain: [], byHeight, orphans: [], competitionHeights: [], interrupted: null, pools };
    }

    // 3) 从最高高度回溯
    const heightRange = minMax(unique.map(r => r.block_height));
    const maxHeight = heightRange.max, minHeight = heightRange.min;
    const hashIndex = new Map(unique.map(r => [norm(r.block_hash), r]));
    const walkBack = (tip) => {
        const path = [], seen = new Set();
        let cur = tip;
        while (cur && !seen.has(norm(cur.block_hash))) {
            path.push(cur);
            seen.add(norm(cur.block_hash));
            cur = cur.prev_hash ? hashIndex.get(norm(cur.prev_hash)) : null;
        }
        return path; // tip → … → 最早可达块
    };
    // 链尖 = 最高高度的块；若并列竞争，取能回溯最长的一条
    let best = [];
    for (const tip of unique.filter(r => r.block_height === maxHeight)) {
        const p = walkBack(tip);
        if (p.length > best.length) best = p;
    }
    const onChain = new Set(best.map(r => norm(r.block_hash)));
    const chain = best.slice().reverse(); // 最低 → 最高

    // 4) 间隔 + 每记录标志（供表格/控制台沿用）
    for (let i = 0; i < chain.length; i++) {
        const w = chain[i], prev = chain[i - 1];
        let interval_s = null;
        if (prev && w.pool_submit_ms != null && prev.pool_submit_ms != null
            && w.block_height === prev.block_height + 1) {
            interval_s = (w.pool_submit_ms - prev.pool_submit_ms) / 1000;
        }
        w.interval_s = interval_s;
        w.isWinner = true; w.isOrphan = false; w.winnerKnown = true;
        w.solutionCount = (byHeight.get(w.block_height) || [w]).length;
        w.isMultiSolution = w.solutionCount > 1;
    }

    // 5) 孤块 / 竞争高度 / 中断
    const orphans = unique.filter(r => !onChain.has(norm(r.block_hash)));
    for (const r of orphans) {
        r.isWinner = false; r.isOrphan = true; r.winnerKnown = true; r.interval_s = null;
        r.solutionCount = (byHeight.get(r.block_height) || []).length;
        r.isMultiSolution = r.solutionCount > 1;
    }
    const competitionHeights = [...byHeight.entries()]
        .filter(([, g]) => g.length > 1).map(([h]) => h).sort((a, b) => a - b);

    const chainMin = chain.length ? chain[0].block_height : null;
    const interrupted = (chainMin != null && chainMin > minHeight)
        ? { gapBelow: chainMin, dataLow: minHeight } : null;

    return { chain, byHeight, orphans, competitionHeights, interrupted, pools };
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

    const { chain, byHeight, orphans, competitionHeights, interrupted, pools } = buildChainView(records);

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

    console.log(`   记录数: ${records.length} | 去重区块: ${byHeight.size} | canonical链: ${chain.length} | 竞争高度: ${competitionHeights.length} | 孤块: ${orphans.length} | 矿池数: ${pools.size}`);
    if (interrupted) {
        console.log(`   ⛓️‍💥 链中断: 仅回溯到高度 ${interrupted.gapBelow}，其下至 ${interrupted.dataLow} 未能连上（断点在 ${interrupted.gapBelow - 1}）`);
    }
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
    const hrRec = [...chain].reverse().find(c => c.hashrate_10min_hs != null);
    if (hrRec) {
        console.log(`   实测算力(最新出块): 10分钟 ${(hrRec.hashrate_10min_hs / 1e12).toFixed(2)} TH/s | 累计 ${(hrRec.hashrate_total_hs / 1e12).toFixed(2)} TH/s`);
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
    const heightsAll = [...byHeight.keys()].filter(h => h != null);
    const heightsAllRange = minMax(heightsAll);
    const fileRange = heightsAllRange ? `${heightsAllRange.min}_${heightsAllRange.max}_` : '';

    if (config.json) {
        const p = path.join(outDir, `pool-solutions_${fileRange}${stamp}.json`);
        fs.writeFileSync(p, JSON.stringify(records, null, 2));
        console.log(`\n📄 JSON: ${p}`);
    }
    if (config.csv) {
        const p = path.join(outDir, `pool-solutions_${fileRange}${stamp}.csv`);
        fs.writeFileSync(p, toCSV(records));
        console.log(`📄 CSV : ${p}`);
    }
    if (config.html) {
        const prevhashPath = config.prevhashFile
            || path.join(path.dirname(filePath), 'pool-prevhash.ndjson');
        const prevhashRecs = loadPrevhashRecords(prevhashPath);
        if (prevhashRecs.length) {
            console.log(`   prev_hash 传播记录: ${prevhashRecs.length} 条 (${prevhashPath})`);
        }
        const p = buildHTML(records, chain, byHeight, stats, mu, dev, outDir, prevhashRecs,
            { orphans, competitionHeights, interrupted, pools,
              poissonWindowSec: config.poissonWindow || 3600, showCrossPool: !!config.crossPool,
              includeGaps: !!config.includeGaps, gapThresholdSec: config.gapThreshold || null });
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

// ============ 泊松计数视图（固定时间窗内出几个块；间隔指数图的对偶）============
//
// 固定窗口 W 内的出块数 k，在理想泊松过程下服从 PMF: P(X=k)=(λW)^k·e^(−λW)/k!。
// 把 canonical 链的区块时间按 W 切片计数。
// opts.excludeGaps=true（默认）：按"大缺口"把时间轴切成连续段、只在段内铺窗口，避免把停机/数据缺口算成 0 块窗口（D 仅反映在线期）；
//   excludeGaps=false：整条时间轴铺满窗口，停机期作为 0 块窗口计入 → D 因停机而偏大（如实反映异常）。
// opts.gapThresholdMs 自定义大缺口阈值（毫秒），默认 max(W×3, 3600000)。
function buildPoissonView(chain, windowSec, opts = {}) {
    const { excludeGaps = true, gapThresholdMs } = opts;
    const times = chain.filter(c => c.pool_submit_ms != null)
        .map(c => c.pool_submit_ms).sort((a, b) => a - b);
    if (times.length < 5) return null;
    const W = windowSec * 1000;
    const GAP = excludeGaps ? (gapThresholdMs || Math.max(W * 3, 3600 * 1000)) : Infinity; // 大缺口: 超过视为停机, 不跨段铺窗
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
    const countRange = minMax(counts);
    const maxK = countRange ? countRange.max : 0;
    const hist = new Array(maxK + 1).fill(0);
    for (const c of counts) hist[c]++;
    const meanCount = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - meanCount) * (b - meanCount), 0) / counts.length;
    const dispersion = meanCount > 0 ? variance / meanCount : 0; // 泊松=1
    return { hist, numWindows: counts.length, maxK, meanCount, dispersion };
}

// 缺口 / 停机汇总：找出 canonical 链上相邻区块 pool_submit_ms 差 > gapThresholdMs 的所有"大缺口"
// （停机 / 断链 / 数据缺失）。这些正是泊松计数 excludeGaps 模式下会剔除的窗口，单列出来使"剔除"可见，
// 并作为与离散指数 D 解耦的 outage 判据。返回 { gaps:[{start,end,duration}](毫秒), count, total, longest }。
function summarizeGaps(chain, gapThresholdMs) {
    const times = chain.filter(c => c.pool_submit_ms != null)
        .map(c => c.pool_submit_ms).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > gapThresholdMs) gaps.push({ start: times[i - 1], end: times[i], duration: d });
    }
    const total = gaps.reduce((a, g) => a + g.duration, 0);
    const longest = gaps.reduce((m, g) => Math.max(m, g.duration), 0);
    return { gaps, count: gaps.length, total, longest };
}

function buildHTML(records, chain, byHeight, stats, mu, dev, outDir, prevhashRecs, view = {}) {
    const { orphans = [], competitionHeights = [], interrupted = null, pools = new Set(),
            poissonWindowSec = 3600, showCrossPool = false,
            includeGaps = false, gapThresholdSec = null } = view;
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
        const positiveIvRange = minMax(ivPts.map(p => p.interval_s).filter(v => v > 0));
        const logYMin = parseFloat((Math.min(positiveIvRange ? positiveIvRange.min : 60, 60) / 60 * 0.5).toFixed(4));
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

    // ---- 图: 实测网络算力（pool 基于 share 统计，10分钟滑窗 + 全程累计）----
    // 用完整 canonical 链做 X 轴，缺字段的块置 null 且 spanGaps:false →
    // 旧记录(无算力字段)所在高度显示为**断口**，既不隐藏缺口、也不跨空连线。
    if (showCrossPool && chain.some(c => c.hashrate_10min_hs != null || c.hashrate_total_hs != null)) {
        builder.addMultiLineChart(
            chain.map(c => `#${c.block_height}`),
            [
                { label: '10分钟滑窗算力 (TH/s)', data: chain.map(c => c.hashrate_10min_hs != null ? +(c.hashrate_10min_hs / 1e12).toFixed(3) : null), color: '#16a085', spanGaps: false },
                { label: '全程累计算力 (TH/s)',  data: chain.map(c => c.hashrate_total_hs != null ? +(c.hashrate_total_hs / 1e12).toFixed(3) : null), color: '#9b59b6', dash: [5, 3], spanGaps: false },
            ],
            { title: '实测网络算力（pool 基于 share 统计 · 金标准）', xLabel: '区块高度', yLabel: '算力 (TH/s)',
              caption: '由 pool 收到的<b>每个被接受 share</b> 还原（H = Σ每share功 / 时间），'
                     + '<b>直接反映真实算力，与出块间隔无关</b>。'
                     + '<span style="color:#16a085"><b>绿线 = 10 分钟滑窗</b></span>（近期算力）、'
                     + '<span style="color:#9b59b6"><b>紫虚线 = 全程累计</b></span>（长期均值）。'
                     + '<br><b>读法</b>：恒定算力应是一条基本水平的线。'
                     + '<b>线在某段断开 = 该段为旧记录、无算力字段</b>（不是掉算力，只是没数据）。'
                     + '与“出块间隔”对照——长块处算力<b>仍水平</b>则该长块<b>不是掉算力</b>（真随机长尾或 stale prev-hash），'
                     + '只有算力出现<b>持续性台阶下降</b>才是真掉算力。（仅出块时刻采样，约每 10 分钟一点。）' }
        );
    }

    // ---- 图: 跨池总算力（仅检测到多个 pool_signature 时显示）----
    if (showCrossPool && pools.size >= 2) {
        const hrRecs = records
            .filter(r => r.hashrate_10min_hs != null && r.pool_submit_ms != null && r.pool_signature != null)
            .sort((a, b) => a.pool_submit_ms - b.pool_submit_ms);
        if (hrRecs.length) {
            const last = new Map(); // pool_signature -> 最近一次 10分钟算力 (H/s)
            const labels = [], totals = [];
            const fmtT = (ms) => {
                const d = new Date(ms);
                return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            };
            for (const r of hrRecs) {
                last.set(r.pool_signature, r.hashrate_10min_hs);
                let sum = 0;
                for (const v of last.values()) sum += v;
                labels.push(fmtT(r.pool_submit_ms));
                totals.push(+(sum / 1e12).toFixed(3));
            }
            builder.addLineChart(labels, totals, {
                title: `跨池总算力（${pools.size} 个矿池 · 10 分钟滑窗求和 · TH/s）`,
                xLabel: '时间', yLabel: '总算力 (TH/s)', label: '跨池总算力',
                pointRadius: 1, beginAtZero: true,
                caption: `检测到 <b>${pools.size} 个不同 pool_signature</b>，按时间推进维护每个池最近一次的 10 分钟算力并求和 `
                       + '= <b>全网实时总算力</b>（阶梯式：某池一出块即刷新它的分量）。'
                       + '<br>单池时此图不显示；旧版记录无算力字段则参与求和的池数减少。'
            });
        }
    }

    // ---- 图: prev_hash 传播延迟 stale_ms（来自 pool-prevhash.ndjson，可选）----
    if (prevhashRecs && prevhashRecs.length) {
        const fmtT = (ms) => {
            const d = new Date(ms);
            return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        };
        builder.addLineChart(
            prevhashRecs.map(r => fmtT(r.tp_recv_ms)),
            prevhashRecs.map(r => r.stale_ms),
            { title: 'prev_hash 传播延迟 stale_ms（矿机在旧 prev_hash 上的无效工作窗口）',
              xLabel: '时间', yLabel: '毫秒', label: 'stale_ms', pointRadius: 2, beginAtZero: true,
              caption: '每次链 tip 变更：从 pool 收到新 prev_hash 到把 SetNewPrevHash 发给矿机的延迟。'
                     + '出块限速关闭（job_dispatch_min_interval_secs=0）时应只有<b>几毫秒</b>（纯传播延迟）；'
                     + '若出现<b>几百~几千毫秒的尖峰</b>，说明矿机这段时间在旧 prev_hash 上挖无效工作 → '
                     + '这正是“长块”的一个<b>真实成因</b>（模板源慢 / 出块限速 / stash-dedup 逻辑问题）。' }
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
    {
        const hasEnoughIntervals = validIv.length >= 2;
        const fallbackBinWidth = 5;
        let binWidth = fallbackBinWidth;
        let numBins = 0;
        let counts = [];

        if (hasEnoughIntervals) {
            const sorted = [...validIv].sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const iqr = q3 - q1;
            const fdWidth = 2 * iqr * Math.pow(validIv.length, -1 / 3);
            binWidth = Math.max(fallbackBinWidth, Math.round(fdWidth || fallbackBinWidth));
            numBins = Math.max(1, Math.ceil((stats.p99 || stats.max) / binWidth));
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
        const validIvRange = minMax(validIv);
        const sub1 = cntIv(0, 60), minIv = validIvRange ? validIvRange.min : null;
        const sub1Note = N > 0
            ? `<br><b>间隔 &lt;1min 细分</b>：共 <b>${sub1}</b> 个（${pc(sub1 / N)}）；`
                + `&lt;10s ${cntIv(0, 10)} 个、10–30s ${cntIv(10, 30)} 个、30–60s ${cntIv(30, 60)} 个；最短间隔 ${minIv.toFixed(0)}s。`
            : '<br><b>实测间隔样本不足</b>：未能计算本链实测密度，仅显示 BTC 理论曲线。';
        // 累计概率(用户口径)：P(<m分钟)
        const cumEmp = m => N > 0 ? validIv.filter(v => v < m * 60).length / N : null;
        // ≤0 间隔(同刻/乱序)出块的实测核查（validIv 已滤 >0，这里从未过滤的 interval_s 数）
        const zeroNeg = chain.map(c => c.interval_s).filter(v => v != null && v <= 0).length;
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

    // ---- 与 BTC 泊松出块的偏离量化（紧跟图4 间隔分布：间隔视角的判定）----
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
                读图：上图(出块间隔概率分布)纵轴是<strong>概率密度</strong>、横轴是<strong>线性时间(分钟)</strong>，<strong>曲线下某区间面积 = 该区间出块概率</strong>。蓝色填充曲线是 <strong>BTC 理论分布（间隔指数 λ=1/600）</strong>，红线是<strong>本链实测</strong>；纵轴是概率<strong>密度</strong>(非概率)，<strong>曲线下面积才是概率</strong>；<strong>10min 粗线 = BTC 目标节奏</strong>。
                四个区带直接标出 <strong>&lt;1m / 1–10m / 10–30m / &gt;30m</strong> 各自的出块概率（实测 vs BTC 理论，四区相加=100%）：红线贴合蓝线、各区间实测≈理论 → 本链出块≈比特币(健康的泊松过程，间隔指数分布)，只是节奏略不同（μ≈595s vs 600s）；
                若红线明显偏离蓝线、或某区间实测概率远偏理论 → 间隔非指数（出块过程本身非泊松，CV、KS_自身会同步偏大）。
            </p>`);
    }

    // ---- 图 + 判定: 泊松计数分布（每窗出块数 k；间隔指数图的对偶视角）----
    {
        // 缺口开关：默认剔除大缺口（D 仅反映在线期）；includeGaps(--include-gaps) 则全部计入（停机也进 D）。
        const excludeGaps = includeGaps !== true;
        const gapThresholdMs = (gapThresholdSec ? gapThresholdSec * 1000 : Math.max(poissonWindowSec * 1000 * 3, 3600 * 1000));
        const gapInfo = summarizeGaps(chain, gapThresholdMs);
        const pv = buildPoissonView(chain, poissonWindowSec, { excludeGaps, gapThresholdMs });
        if (pv && pv.numWindows >= 3 && mu > 0) {
            const fact = (k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
            const pmf = (k, m) => Math.pow(m, k) * Math.exp(-m) / fact(k);
            const meanMeas = poissonWindowSec / mu;   // λW 实测 = W/μ
            const meanBtc = poissonWindowSec / 600;    // λW BTC  = W/600
            const kMax = Math.max(pv.maxK + 2, Math.ceil(meanBtc * 1.5) + 1);
            const labels = [], counts = [], colors = [], measCurve = [], btcCurve = [];
            for (let k = 0; k <= kMax; k++) {
                labels.push(String(k));
                counts.push(pv.hist[k] || 0);
                colors.push('#3498db');
                measCurve.push(+(pv.numWindows * pmf(k, meanMeas)).toFixed(2));
                btcCurve.push(+(pv.numWindows * pmf(k, meanBtc)).toFixed(2));
            }
            const wm = (poissonWindowSec % 3600 === 0) ? `${poissonWindowSec / 3600} 小时`
                     : (poissonWindowSec % 60 === 0 ? `${poissonWindowSec / 60} 分钟` : `${poissonWindowSec}s`);
            const band = 2 * Math.sqrt(2 / Math.max(pv.numWindows - 1, 1));
            const D = pv.dispersion;
            const dOk = Math.abs(D - 1) <= band;
            const verdict = dOk ? '✅ 符合泊松(D≈1)'
                          : (D < 1 ? '❌ 过于规整(D<1,出块比泊松更均匀→疑节流/调控)'
                                   : '❌ 过度聚集(D>1,比泊松更扎堆)');
            builder.addBarChart(labels, counts, {
                title: `每${wm}出块数分布 · 离散指数 D=${D.toFixed(2)} ${verdict}`,
                xLabel: '窗口内出块数 k（一个窗口里出了几个块）', yLabel: '窗口数（有多少个这样的窗口）',
                colors,
                normalCurve: measCurve, normalCurveLabel: `实测泊松 均值${meanMeas.toFixed(2)} 块/窗 (=W/μ)`,
                normalCurve2: btcCurve, normalCurve2Label: `BTC 泊松 均值${meanBtc.toFixed(2)} 块/窗`,
                totalCount: pv.numWindows,
                caption: `横轴 k = 一个 ${wm} 窗口内的出块数；纵轴 = 有多少个这样的窗口（柱=实测，线=理论泊松期望）。公式、本数据参数与正常判据见下方注释表。`,
            });
            builder.addNote(`
                <h3>出块计数泊松检验（上图：每${wm}出块数分布）</h3>
                <p>把时间轴切成 ${wm} 的固定窗口（共 <b>${pv.numWindows}</b> 个，${excludeGaps ? '已按大缺口<b>剔除</b>停机期' : '<b>含</b>停机期(<code>--include-gaps</code>)'}），数每个窗口出了几个块 k。
                   理想泊松过程下 k 服从
                   <span style="font-family:monospace;background:#eef;padding:2px 8px;border-radius:4px;">P(X=k) = (λW)<sup>k</sup>·e<sup>−λW</sup> / k!</span>
                   （λ=出块速率，W=窗口长度，λW=每窗平均出块数）。曲线值 = 窗口数 × P(X=k)。下表按<strong>本数据实测</strong>列出：</p>
                <table>
                    <tr><th>项</th><th>数值（本数据）</th><th>含义 / 判读</th></tr>
                    <tr><td>窗口长度 W</td><td>${wm}（${poissonWindowSec}s）</td><td>每个计数窗口的时长（--poisson-window 可调）</td></tr>
                    <tr><td>窗口个数 N</td><td>${pv.numWindows}</td><td>样本量；越多柱子越平滑可信</td></tr>
                    <tr><td>实测 λW（红线均值）</td><td>${meanMeas.toFixed(2)} 块/窗</td><td>= W/μ（μ=${mu.toFixed(0)}s），本链每窗平均出块</td></tr>
                    <tr><td>BTC λW（紫虚线均值）</td><td>${meanBtc.toFixed(2)} 块/窗</td><td>= W/600，BTC 参考节奏</td></tr>
                    <tr><td>离散指数 D = σ²/均值</td><td><b>${D.toFixed(3)}</b></td><td>泊松理论值 = 1.00 —— <strong>判正常与否的核心指标</strong></td></tr>
                    <tr><td>95% 容许带</td><td>[${(1 - band).toFixed(2)}, ${(1 + band).toFixed(2)}]</td><td>1 ± 2√(2/(N−1))；D 落带内即正常</td></tr>
                    <tr><td><strong>判定</strong></td><td><strong style="color:${dOk ? '#27ae60' : '#e74c3c'}">${verdict}</strong></td><td>D 在带内 → 符合泊松；偏出 → 异常</td></tr>
                </table>
                <p style="font-size:13px;color:#666;">
                    <b>怎么读</b>：不必肉眼比对每根柱——柱子是计数，天然有 ±√值 的随机抖动（个别柱比曲线高/低 1~2σ 都属正常）。
                    <b>只看 D 与判定</b>：D≈1 且在带内 = 出块数服从泊松（健康；与"间隔服从指数"是同一过程的两种视角，应同时为 ✅）；
                    D&lt;1 = 过于规整（疑节流/调控），D&gt;1 = 过度扎堆。本表是<strong>计数视角</strong>，与上方"偏离量化"表的<strong>间隔视角</strong>互为对偶。
                </p>
                <p style="font-size:13px;color:#888;">单位提醒：本图均值是<b>块/窗</b>（每窗出几个块），间隔图/偏离表的 μ 是<b>秒/块</b>，二者互为倒数 <b>均值 = W / μ</b>。间隔越短 ⟺ 每窗出块越多，两数方向相反是必然，<b>不矛盾</b>。</p>`);
        }

        // ---- 缺口 / 停机汇总 + outage 判据（让"剔除"可见，并与离散指数 D 解耦地报告停机）----
        {
            const fmtDur = ms => ms >= 3600000 ? `${(ms / 3600000).toFixed(2)} h` : (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
            const fmtTs = ms => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '');
            const muMs = mu * 1000;
            const rows = gapInfo.gaps
                .slice().sort((a, b) => b.duration - a.duration)
                .map(g => `<tr><td>${fmtTs(g.start)} → ${fmtTs(g.end)} UTC</td><td>${fmtDur(g.duration)}</td>`
                    + `<td>≈ 丢失 ${muMs > 0 ? Math.round(g.duration / muMs) : '?'} 个区块时间（${muMs > 0 ? (g.duration / muMs).toFixed(0) : '?'}×μ）</td></tr>`)
                .join('');
            const outageVerdict = gapInfo.count > 0
                ? `<strong style="color:#e74c3c">⚠ 检测到 ${gapInfo.count} 次停机/断链</strong>（最长 ${fmtDur(gapInfo.longest)}，累计 ${fmtDur(gapInfo.total)}）`
                : `<strong style="color:#27ae60">✅ 无大缺口（无超过阈值的停机）</strong>`;
            const modeTxt = excludeGaps
                ? '本次为<b>剔除模式</b>（默认）：以下缺口<b>已从泊松计数 D 中剔除</b>，D 仅反映"在线期"出块节奏。要让 D 把停机也算进去，运行时加 <code>--include-gaps</code>。'
                : '本次为<b>包含模式</b>（<code>--include-gaps</code>）：以下缺口<b>已计入泊松计数</b>，D 会因停机而偏大（过度离散，如实反映异常）。';
            builder.addNote(`
                <h3>缺口 / 停机汇总（outage 判据，与离散指数 D 解耦）</h3>
                <p>大缺口阈值 = <b>${fmtDur(gapThresholdMs)}</b>（${Math.round(gapThresholdMs / 1000)}s，<code>--gap-threshold</code> 可调，单位秒）。canonical 链上相邻区块 pool_submit_time 超过该阈值即判为<b>停机 / 断链 / 数据缺失</b>，独立于 D 单独报告——这样泊松计数“剔除了什么”始终可见，不会用一个 ✅ 把真实停机洗白。</p>
                <p>判定：${outageVerdict}</p>
                <p style="font-size:13px;color:#666;">${modeTxt}</p>
                ${gapInfo.count > 0 ? `<table><tr><th>缺口区间 (UTC)</th><th>时长</th><th>影响（相对实测 μ=${mu.toFixed(0)}s）</th></tr>${rows}</table>` : ''}
            `);
        }
    }

    // ---- canonical 链重建说明（去重 + 反向溯链 + 排除分叉 + 中断标记）----
    builder.addNote(`
        <h3>canonical 链重建（反向溯链）</h3>
        <p>支持<strong>多池导出文件直接拼接</strong>（同链由使用方保证）。重建步骤：
           按 <code>block_hash</code> 去重（同一区块被多池各记一条 → 只算一个，取<strong>最早 pool_submit_time</strong>）→
           从<strong>最高高度</strong>沿 <code>prev_hash</code> 回溯出唯一最长正确链 → 不在链上的块即<strong>孤块/分叉</strong>，自动排除。</p>
        <table>
            <tr><th>指标</th><th>值</th></tr>
            <tr><td>去重后区块</td><td>${byHeight.size}</td></tr>
            <tr><td>canonical 链长度</td><td>${chain.length}（高度 ${chain.length ? chain[0].block_height : '-'} → ${chain.length ? chain[chain.length - 1].block_height : '-'}）</td></tr>
            <tr><td>竞争高度（同高度不同 hash）</td><td>${competitionHeights.length}${competitionHeights.length ? '：' + competitionHeights.slice(0, 20).join(', ') + (competitionHeights.length > 20 ? ' …' : '') : ''}</td></tr>
            <tr><td>排除的孤块/分叉</td><td>${orphans.length}</td></tr>
            <tr><td>参与矿池数（pool_signature）</td><td>${pools.size}${pools.size ? '：' + [...pools].slice(0, 8).join(', ') : ''}</td></tr>
            <tr><td>链完整性</td><td>${interrupted
                ? `<strong style="color:#e74c3c">⛓️‍💥 中断：仅回溯到高度 ${interrupted.gapBelow}，其下至 ${interrupted.dataLow} 未连上（断点在 ${interrupted.gapBelow - 1}）</strong>`
                : '<strong style="color:#27ae60">✅ 完整（最高高度可回溯至最低高度）</strong>'}</td></tr>
        </table>
        <p style="font-size:13px;color:#666;">高度-时间反向校验：canonical 链上更高高度的 pool_submit_time 不应早于更低高度；
           若违反会表现为相邻 <code>interval ≤ 0</code>，在下方“出块时间异常判定”中标出（链溯错 / 时钟回拨）。</p>`);

    // ---- 异常判定说明 ----
    const multiCount = competitionHeights.length;
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
        <p>统计：高度 ${byHeight.size} 个，多解竞争 ${multiCount} 处，命中异常 ${anomalyCount} 条。
           （三时间源 submit−e2 / header−e2 的读法见上方"时间源一致性"图的说明。）</p>
        <p style="color:#888;font-size:12px;">※ 公式与阈值为起步基线，确定正式判据后可在 flagAnomalies() 中调整。</p>
    `);

    // 标题/文件名附带高度范围，如「Pool 出块记录分析报告 (836261-836370)」
    const heights = [...byHeight.keys()].filter(h => h != null);
    const heightRange = minMax(heights);
    const titleRange = heightRange ? ` (${heightRange.min}-${heightRange.max})` : '';
    const fileRange = heightRange ? `${heightRange.min}_${heightRange.max}_` : '';

    return builder
        .setTitle(`${ANALYZER_INFO.name}报告${titleRange}`)
        .save(`pool-solutions_${fileRange}${Date.now()}.html`, outDir);
}

// ============ 命令行 ============
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {};
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--file': case '-f': config.file = args[++i]; break;
            case '--out':             config.out  = args[++i]; break;
            case '--prevhash-file':   config.prevhashFile = args[++i]; break;
            case '--poisson-window':  config.poissonWindow = parseInt(args[++i], 10); break;
            case '--cross-pool':      config.crossPool = true; break;
            case '--include-gaps':    config.includeGaps = true; break;
            case '--gap-threshold':   config.gapThreshold = parseInt(args[++i], 10); break;
            case '--html':            config.html = true;      break;
            case '--json':            config.json = true;      break;
            case '--csv':             config.csv  = true;      break;
            case '--help': case '-h': printUsage(); process.exit(0);
            default:
                // 位置参数：第一个非选项参数当数据文件路径（等价于 --file）
                if (!args[i].startsWith('-') && config.file == null) config.file = args[i];
                break;
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
    console.log(`  node ${path.basename(__filename)} ../sub.ndjson --html   # 文件名任意，位置参数即数据文件`);
}

// ============ 导出和独立运行 ============
module.exports = { info: ANALYZER_INFO, analyze: analyzePoolSolutions };

if (require.main === module) {
    const config = parseArgs();
    try { analyzePoolSolutions(config); }
    catch (err) { console.error('错误:', err.message); process.exit(1); }
}
