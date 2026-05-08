/**
 * 分析器: 难度调整窗口分析 (DifficultyWindow)
 *
 * 复现 pow.cpp 中的 TBC DAA 逻辑，逐块分析：
 *   - 144块窗口 ComputeTarget 计算出的原始 target
 *   - 8064块窗口 GetNewBlockSpacing 的效果
 *   - rate limit 是否触发（±6.25%/块）
 *   - 实际 nBits 与理论值对比，标出不一致
 *
 * 独立运行: node analyzers/difficulty-window.js --start 828400 --end 828446
 * 框架调用: ./framework.js difficulty-window --start 828400 --end 828446 --html
 */

'use strict';

const { RPCClient } = require('../lib/rpc');
const { Reporter }  = require('../lib/reporter');
const fs            = require('fs');
const path          = require('path');

// ── 分析器元信息 ──────────────────────────────────────────────────
const ANALYZER_INFO = {
    id:          'difficulty-window',
    name:        '难度调整窗口分析',
    description: '复现 TBC DAA 逻辑，逐块分析每个 144-block 窗口是否应调整难度及原因',
    icon:        '⛏️',
    version:     '1.0.0',
    options: [
        { name: 'start',  alias: 's', type: 'number',  description: '起始区块高度',       default: null  },
        { name: 'end',    alias: 'e', type: 'number',  description: '结束区块高度',        default: null  },
        { name: 'html',               type: 'boolean', description: '生成 HTML 报告',      default: false },
        { name: 'chart',              type: 'boolean', description: '显示 ASCII 难度图',   default: false },
    ]
};

// ── 链参数（mainnet）──────────────────────────────────────────────
const P = {
    TBC_FIRST:   824190,
    BACK_NUM:    8064n,
    SPACING:     600n,          // nPowTargetSpacing
    POW_LIMIT:   (1n << 224n) - 1n,
    DAA_HEIGHT:  504031,
};

// ── compact ↔ 256-bit target ──────────────────────────────────────
function compactToTarget(compact) {
    const c        = BigInt(compact >>> 0);
    const mantissa = c & 0x007fffffn;
    const exp      = Number((c >> 24n) & 0xffn);
    return exp <= 3
        ? mantissa >> BigInt(8 * (3 - exp))
        : mantissa << BigInt(8 * (exp - 3));
}

function targetToCompact(target) {
    if (target <= 0n) return 0;
    let size = 0;
    let tmp  = target;
    while (tmp > 0n) { tmp >>= 8n; size++; }
    let mantissa = size <= 3
        ? Number(target << BigInt(8 * (3 - size)))
        : Number(target >> BigInt(8 * (size - 3)));
    if (mantissa & 0x800000) { mantissa >>= 8; size++; }
    return (size << 24) | (mantissa & 0x7fffff);
}

// ── GetSuitableBlock：3块时间中位数（pow.cpp:290） ────────────────
function getSuitableBlock(b0, b1, b2) {
    return [b0, b1, b2].slice().sort((a, b) => a.time - b.time)[1];
}

// ── ComputeTarget（pow.cpp:246） ──────────────────────────────────
function computeTarget(first, last, newBlockSpacing) {
    const firstWork = BigInt('0x' + first.chainwork);
    const lastWork  = BigInt('0x' + last.chainwork);

    let work            = (lastWork - firstWork) * newBlockSpacing;
    const rawTimespan   = BigInt(last.time - first.time);
    const minTs         = 72n  * P.SPACING;
    const maxTs         = 288n * P.SPACING;
    let   clampedTs     = rawTimespan < minTs ? minTs : rawTimespan > maxTs ? maxTs : rawTimespan;

    work /= clampedTs;

    // (-work) / work = (2^256 - work) / work
    const target = work > 0n ? ((1n << 256n) - work) / work : P.POW_LIMIT;
    return {
        target:        target > P.POW_LIMIT ? P.POW_LIMIT : target,
        rawTimespan:   Number(rawTimespan),
        clampedTs:     Number(clampedTs),
    };
}

// ── GetNewBlockSpacing（pow.cpp:75） ──────────────────────────────
function getNewBlockSpacing(prevBlock, anchorBlock) {
    if (!anchorBlock) return P.SPACING;
    const timeDiff      = BigInt(prevBlock.time - anchorBlock.time);
    const nPromised     = timeDiff / P.SPACING;
    if (nPromised > P.BACK_NUM) {
        const capped = nPromised > P.BACK_NUM * 2n ? P.BACK_NUM * 2n : nPromised;
        return P.SPACING * P.BACK_NUM / capped;
    }
    return P.SPACING;
}

// ── 难度比（相对最低难度）────────────────────────────────────────
const MIN_TARGET = compactToTarget(0x1d00ffff);
function diffRatio(bitsCompact) {
    const t = compactToTarget(bitsCompact >>> 0);
    if (t === 0n) return Infinity;
    // 用 Number 精度足够（只需 4 位有效数字）
    return Number((MIN_TARGET * 100000n) / t) / 100000;
}

// ── 主分析逻辑 ────────────────────────────────────────────────────
async function analyzeDifficultyWindow(config = {}) {
    const rpc      = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    const latestHeight = await rpc.getBlockCount();
    const endHeight    = config.end   || latestHeight;
    const startHeight  = config.start || Math.max(P.TBC_FIRST + 148, endHeight - 99);

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('分析范围', `${startHeight} → ${endHeight}`);
    reporter.kv('区块数量', endHeight - startHeight + 1);

    // ── 预取策略 ─────────────────────────────────────────────────
    // 对每个分析高度 H，需要：
    //   H-147 ~ H   : 用于 GetSuitableBlock（前后3块）+ 144块窗口 + 实际结果
    //   H-8065      : GetNewBlockSpacing 的 anchor 块
    //   H-13        : MTP12 pindex12
    // 所有 anchor 块范围：[start-8065, end-8065]

    const mainFrom    = Math.max(0, startHeight - 147);
    const mainTo      = endHeight;
    const anchorFrom  = Math.max(0, startHeight - 1 - Number(P.BACK_NUM));
    const anchorTo    = Math.max(0, endHeight   - 1 - Number(P.BACK_NUM));

    reporter.section('预取区块...');

    const blockCache = new Map();

    async function fetchRange(from, to, label) {
        const batchSize = 50;
        const total     = to - from + 1;
        for (let h = from; h <= to; h += batchSize) {
            const bEnd = Math.min(h + batchSize - 1, to);
            await Promise.all(
                Array.from({ length: bEnd - h + 1 }, (_, i) => h + i)
                    .filter(height => !blockCache.has(height))
                    .map(height =>
                        rpc.getBlock(height, 1)
                            .then(b  => blockCache.set(height, b))
                            .catch(() => null)
                    )
            );
            const done = bEnd - from + 1;
            process.stdout.write(`\r  ${label}: ${done}/${total} (${((done/total)*100).toFixed(0)}%)`);
        }
        process.stdout.write('\n');
    }

    await fetchRange(mainFrom,   mainTo,   `主区间 [${mainFrom}~${mainTo}]`);
    if (anchorFrom > 0 && anchorFrom <= anchorTo) {
        await fetchRange(anchorFrom, anchorTo, `回溯区间 [${anchorFrom}~${anchorTo}]`);
    }

    // ── 逐块计算 ─────────────────────────────────────────────────
    const rows = [];

    for (let H = startHeight; H <= endHeight; H++) {
        const prevBlock = blockCache.get(H - 1);
        if (!prevBlock) { rows.push({ height: H, reason: 'MISSING_DATA' }); continue; }

        // fork 硬编码点
        if (H - 1 === 824188) {
            const ab = blockCache.get(H);
            rows.push({ height: H, reason: 'HARDCODED_FORK',
                actualBits: ab ? parseInt(ab.bits, 16) : null,
                computedBits: 0x1d00ffff, match: true,
                windowAvgInterval: 0, newBlockSpacing: 600, mtp12: 0 });
            continue;
        }

        const hPrev = H - 1;

        // TBC DAA 检查（mainnet daaHeight=504031 早已激活，仅检查 TBC 分支）
        if (hPrev < P.TBC_FIRST - 1) {
            rows.push({ height: H, reason: 'PRE_TBC' }); continue;
        }

        // GetSuitableBlock(pindexPrev) → pindexLast
        const [lB1, lB2, lB3] = [blockCache.get(hPrev), blockCache.get(hPrev-1), blockCache.get(hPrev-2)];
        if (!lB1 || !lB2 || !lB3) { rows.push({ height: H, reason: 'MISSING_DATA' }); continue; }
        const pindexLast = getSuitableBlock(lB1, lB2, lB3);

        // GetSuitableBlock(GetAncestor(hPrev-144)) → pindexFirst
        const hFirst = hPrev - 144;
        const [fB1, fB2, fB3] = [blockCache.get(hFirst), blockCache.get(hFirst-1), blockCache.get(hFirst-2)];
        if (!fB1 || !fB2 || !fB3) { rows.push({ height: H, reason: 'MISSING_DATA' }); continue; }
        const pindexFirst = getSuitableBlock(fB1, fB2, fB3);

        // GetNewBlockSpacing
        const anchorBlock   = blockCache.get(hPrev - Number(P.BACK_NUM));
        const newSpacing    = getNewBlockSpacing(lB1, anchorBlock);

        // ComputeTarget
        const { target: rawTarget, rawTimespan, clampedTs } = computeTarget(pindexFirst, pindexLast, newSpacing);

        // prevTarget & rate limits
        const prevBits         = parseInt(lB1.bits, 16);
        const prevTarget       = compactToTarget(prevBits);
        let   upLimit          = prevTarget + (prevTarget >> 4n);
        if (upLimit >= P.POW_LIMIT) upLimit = P.POW_LIMIT;
        const dnLimit          = prevTarget - (prevTarget >> 4n);

        // MTP12：pindexPrev.mediantime - pindex12.mediantime
        const pindex12   = blockCache.get(hPrev - 12);
        const mtp12      = pindex12 ? (lB1.mediantime - pindex12.mediantime) : 0;

        // 决策（pow.cpp:381-398）
        let finalTarget, reason;
        if (rawTarget > upLimit) {
            finalTarget = upLimit;
            reason      = 'RATE_LIMIT_UP';       // 出块慢，降难度被限速
        } else if (mtp12 > 6 * 3600) {
            finalTarget = upLimit;
            reason      = 'MTP12_EMERGENCY';     // 12块中位时间 > 6h，紧急降难度
        } else if (rawTarget < dnLimit) {
            finalTarget = dnLimit;
            reason      = 'RATE_LIMIT_DN';       // 出块快，提难度被限速
        } else {
            finalTarget = rawTarget;
            reason      = 'DAA_NORMAL';          // 正常 DAA 调整范围内
        }

        const computedBits = targetToCompact(finalTarget);
        const rawBits      = targetToCompact(rawTarget);
        const upBits       = targetToCompact(upLimit);
        const dnBits       = targetToCompact(dnLimit);

        const actualBlock  = blockCache.get(H);
        const actualBits   = actualBlock ? parseInt(actualBlock.bits, 16) : null;
        const match        = actualBits !== null ? (computedBits === actualBits) : null;

        rows.push({
            height:            H,
            actualBits,
            computedBits,
            rawBits,
            upBits,
            dnBits,
            prevBits,
            match,
            reason,
            windowAvgInterval: rawTimespan / 144,
            clampedTs,
            newBlockSpacing:   Number(newSpacing),
            mtp12,
        });
    }

    // ── 控制台表格 ───────────────────────────────────────────────
    reporter.section('逐块难度窗口分析');

    const REASONS = {
        'RATE_LIMIT_UP':   '↑限速  (慢块降难度被夹)',
        'RATE_LIMIT_DN':   '↓限速  (快块提难度被夹)',
        'MTP12_EMERGENCY': '⚡MTP12 (紧急降难度)',
        'DAA_NORMAL':      '○ 正常 DAA 调整',
        'HARDCODED_FORK':  '★ Fork 锚点',
        'PRE_TBC':         '— TBC 前区块',
        'MISSING_DATA':    '? 数据缺失',
    };

    // 表头
    const COL = [8, 12, 12, 12, 12, 10, 12, 8, 26, 4];
    const HDR  = ['高度','实际bits','计算bits','下限bits','上限bits','窗口均间隔','NewSpacing','MTP12','原因','匹配'];
    const sep  = COL.map(w => '─'.repeat(w)).join('─┼─');
    console.log('\n' + HDR.map((h, i) => h.padEnd(COL[i])).join(' │ '));
    console.log(sep);

    const reasonCount  = {};
    let   mismatchCnt  = 0;
    const validRows    = rows.filter(r => r.computedBits !== undefined);

    for (const r of validRows) {
        const label = REASONS[r.reason] || r.reason;
        reasonCount[r.reason] = (reasonCount[r.reason] || 0) + 1;
        if (r.match === false) mismatchCnt++;

        const fmt = (bits) => bits ? '0x' + (bits >>> 0).toString(16).padStart(8,'0') : '(未知)';
        const matchStr = r.match === null ? ' ?  ' : r.match ? ' ✓  ' : ' ✗  ';

        console.log([
            String(r.height).padEnd(COL[0]),
            fmt(r.actualBits).padEnd(COL[1]),
            fmt(r.computedBits).padEnd(COL[2]),
            fmt(r.dnBits).padEnd(COL[3]),
            fmt(r.upBits).padEnd(COL[4]),
            `${r.windowAvgInterval ? r.windowAvgInterval.toFixed(0)+'s' : '-'}`.padEnd(COL[5]),
            `${r.newBlockSpacing}s`.padEnd(COL[6]),
            `${(r.mtp12/3600).toFixed(1)}h`.padEnd(COL[7]),
            label.padEnd(COL[8]),
            matchStr,
        ].join(' │ '));
    }

    // ── ASCII 难度图 ─────────────────────────────────────────────
    if (config.chart && validRows.length > 0) {
        reporter.section('难度比变化（相对最低难度=1.0）');
        const chartWidth  = 72;
        const chartHeight = 12;
        const diffValues  = validRows.map(r => diffRatio(r.actualBits));
        const minD        = Math.min(...diffValues);
        const maxD        = Math.max(...diffValues);
        const rangeD      = maxD - minD || 0.001;

        const canvas = Array.from({ length: chartHeight }, () => Array(chartWidth).fill(' '));
        // Y 轴
        for (let y = 0; y < chartHeight; y++) canvas[y][0] = '│';
        // 底轴
        for (let x = 1; x < chartWidth; x++) canvas[chartHeight - 1][x] = '─';
        canvas[chartHeight - 1][0] = '└';

        // 绘点
        for (let i = 0; i < validRows.length; i++) {
            const xPos = 1 + Math.floor(i / (validRows.length - 1 || 1) * (chartWidth - 2));
            const yNorm = (diffValues[i] - minD) / rangeD;
            const yPos  = chartHeight - 2 - Math.floor(yNorm * (chartHeight - 2));
            if (yPos >= 0 && yPos < chartHeight - 1 && xPos < chartWidth) {
                const r = validRows[i];
                canvas[yPos][xPos] = r.reason === 'RATE_LIMIT_DN' ? '▲'
                                   : r.reason === 'RATE_LIMIT_UP' ? '▼'
                                   : r.reason === 'DAA_NORMAL'    ? '○'
                                   : '·';
            }
        }

        console.log(`  高 ${maxD.toFixed(4)}`);
        canvas.forEach(row => console.log('  ' + row.join('')));
        console.log(`  低 ${minD.toFixed(4)}  [▲=快块提难度被限速  ▼=慢块降难度被限速  ○=正常DAA]`);
        console.log(`  X轴: ${validRows[0]?.height} → ${validRows[validRows.length-1]?.height}`);
    }

    // ── 汇总统计 ─────────────────────────────────────────────────
    reporter.section('汇总');
    for (const [reason, count] of Object.entries(reasonCount)) {
        reporter.kv(REASONS[reason] || reason, `${count} 块`);
    }
    if (mismatchCnt > 0) {
        reporter.kv('⚠ 计算与实际不符', `${mismatchCnt} 块（可能是 fork 前块或数据缺失）`);
    } else if (validRows.length > 0) {
        reporter.kv('计算与实际', '完全吻合 ✓');
    }

    // ── HTML 报告 ─────────────────────────────────────────────────
    let htmlPath = null;
    if (config.html && validRows.length > 0) {
        htmlPath = buildHTML(validRows, startHeight, endHeight, config.outputDir || './reports');
        reporter.log(`\n${'═'.repeat(60)}`);
        reporter.log(`📄 HTML 报告: ${htmlPath}`);
        reporter.log('═'.repeat(60));
    }

    return {
        info:     ANALYZER_INFO,
        config:   { startHeight, endHeight },
        data:     { rows: validRows, reasonCount, mismatchCnt },
        htmlPath,
    };
}

// ── HTML 报告生成（多数据集折线图）────────────────────────────────
function buildHTML(rows, startH, endH, outputDir) {
    const labels      = rows.map(r => r.height);
    const actualDiff  = rows.map(r => r.actualBits   ? +diffRatio(r.actualBits).toFixed(5)   : null);
    const computedDiff= rows.map(r => r.computedBits ? +diffRatio(r.computedBits).toFixed(5) : null);
    const upDiff      = rows.map(r => r.upBits        ? +diffRatio(r.upBits).toFixed(5)       : null);
    const dnDiff      = rows.map(r => r.dnBits        ? +diffRatio(r.dnBits).toFixed(5)       : null);
    const intervals   = rows.map(r => r.windowAvgInterval ? +r.windowAvgInterval.toFixed(1)  : null);
    const newSpacings = rows.map(r => r.newBlockSpacing);

    // 原因颜色映射
    const reasonColorMap = {
        'RATE_LIMIT_UP':   '#e74c3c',
        'RATE_LIMIT_DN':   '#27ae60',
        'MTP12_EMERGENCY': '#e67e22',
        'DAA_NORMAL':      '#3498db',
        'HARDCODED_FORK':  '#9b59b6',
    };
    const pointColors = rows.map(r => reasonColorMap[r.reason] || '#95a5a6');
    const matchFlags  = rows.map(r => r.match);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>难度调整窗口分析 (${startH}–${endH})</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:20px;background:#f5f7fa;color:#333}
.container{max-width:1400px;margin:0 auto}
.header{background:linear-gradient(135deg,#2c3e50,#3498db);color:#fff;padding:28px;border-radius:12px;margin-bottom:20px}
.header h1{margin:0 0 8px 0;font-size:22px}
.header p{margin:0;opacity:.85;font-size:14px}
.card{background:#fff;padding:20px;border-radius:12px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.card h2{margin:0 0 14px 0;font-size:16px;color:#555}
canvas{max-height:350px}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:13px}
.legend-item{display:flex;align-items:center;gap:6px}
.legend-dot{width:12px;height:12px;border-radius:50%}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:#fff;padding:16px;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.05);text-align:center}
.stat-card .val{font-size:26px;font-weight:700;color:#2c3e50}
.stat-card .lbl{font-size:12px;color:#888;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
thead tr{background:#f0f4f8}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #eee}
tr:hover td{background:#fafafa}
.match-ok{color:#27ae60;font-weight:700}
.match-ng{color:#e74c3c;font-weight:700}
.reason-RATE_LIMIT_UP{color:#e74c3c}
.reason-RATE_LIMIT_DN{color:#27ae60}
.reason-MTP12_EMERGENCY{color:#e67e22;font-weight:700}
.reason-DAA_NORMAL{color:#3498db}
.reason-HARDCODED_FORK{color:#9b59b6}
</style>
</head>
<body>
<div class="container">

<div class="header">
  <h1>⛏️ 难度调整窗口分析</h1>
  <p>区间: 区块 ${startH} → ${endH} &nbsp;|&nbsp; 共 ${rows.length} 块 &nbsp;|&nbsp; 生成时间: ${new Date().toLocaleString('zh-CN')}</p>
</div>

<div class="stats-grid">
  ${buildStatCards(rows, reasonColorMap)}
</div>

<div class="card">
  <h2>难度比变化（相对最低难度 1.0 = bits: 1d00ffff）</h2>
  <canvas id="diffChart"></canvas>
  <p style="margin:8px 0 0 0;font-size:12px;color:#888">
    实线散点颜色：
    <span style="color:#27ae60">●绿=快块提难度被限速</span> &nbsp;
    <span style="color:#e74c3c">●红=慢块降难度被限速</span> &nbsp;
    <span style="color:#3498db">●蓝=正常DAA</span> &nbsp;
    <span style="color:#e67e22">●橙=MTP12紧急</span>
  </p>
</div>

<div class="card">
  <h2>144块窗口平均出块间隔（秒）&amp; GetNewBlockSpacing</h2>
  <canvas id="intervalChart"></canvas>
</div>

<div class="card">
  <h2>逐块明细</h2>
  <table>
    <thead>
      <tr>
        <th>高度</th><th>实际 bits</th><th>计算 bits</th>
        <th>下限 bits</th><th>上限 bits</th>
        <th>窗口均间隔</th><th>NewSpacing</th><th>MTP12</th>
        <th>原因</th><th>匹配</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r => buildTableRow(r)).join('\n      ')}
    </tbody>
  </table>
</div>

</div><!-- /container -->

<script>
const labels = ${JSON.stringify(labels)};

// ── 难度比折线图 ──
(function(){
  const ctx = document.getElementById('diffChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'实际 bits', data:${JSON.stringify(actualDiff)},
          borderColor:'#2c3e50', backgroundColor:'rgba(44,62,80,.08)',
          borderWidth:2, fill:false, tension:.3, pointRadius:3,
          pointBackgroundColor:${JSON.stringify(pointColors)} },
        { label:'DAA 计算值', data:${JSON.stringify(computedDiff)},
          borderColor:'#3498db', borderWidth:1.5, borderDash:[4,3],
          fill:false, tension:.3, pointRadius:0 },
        { label:'提难度上限（dnLimit）', data:${JSON.stringify(dnDiff)},
          borderColor:'#27ae60', borderWidth:1, borderDash:[2,4],
          fill:false, tension:.3, pointRadius:0 },
        { label:'降难度上限（upLimit）', data:${JSON.stringify(upDiff)},
          borderColor:'#e74c3c', borderWidth:1, borderDash:[2,4],
          fill:false, tension:.3, pointRadius:0 },
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{
          display: true,
          position: 'top',
          labels: { boxWidth: 24, padding: 14, font: { size: 12 } }
        },
        tooltip:{
          callbacks:{
            title: ctx => '高度: ' + ctx[0].label,
            afterBody: (ctx) => {
              const i = ctx[0].dataIndex;
              const reasons = ${JSON.stringify(rows.map(r => r.reason))};
              const LABELS = {
                RATE_LIMIT_UP:'↑限速(慢块降难度被夹)',
                RATE_LIMIT_DN:'↓限速(快块提难度被夹)',
                MTP12_EMERGENCY:'⚡MTP12紧急',
                DAA_NORMAL:'○正常DAA调整',
                HARDCODED_FORK:'★Fork锚点',
              };
              return '原因: ' + (LABELS[reasons[i]] || reasons[i]);
            }
          }
        }
      },
      scales:{
        x:{title:{display:true,text:'区块高度'}, ticks:{maxTicksLimit:20}},
        y:{title:{display:true,text:'难度比（1.0=最低难度）'}, beginAtZero:false}
      }
    }
  });
})();

// ── 间隔折线图 ──
(function(){
  const ctx = document.getElementById('intervalChart').getContext('2d');
  new Chart(ctx, {
    type:'line',
    data:{
      labels,
      datasets:[
        { label:'窗口均间隔(s)', data:${JSON.stringify(intervals)},
          borderColor:'#8e44ad', backgroundColor:'rgba(142,68,173,.06)',
          borderWidth:2, fill:true, tension:.3, pointRadius:0 },
        { label:'NewBlockSpacing(s)', data:${JSON.stringify(newSpacings)},
          borderColor:'#f39c12', borderWidth:1.5, borderDash:[4,3],
          fill:false, tension:0, pointRadius:0 },
        { label:'目标600s', data:${JSON.stringify(labels.map(() => 600))},
          borderColor:'rgba(0,0,0,.2)', borderWidth:1, borderDash:[2,6],
          fill:false, pointRadius:0 },
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{
          display: true,
          position: 'top',
          labels: { boxWidth: 24, padding: 14, font: { size: 12 } }
        }
      },
      scales:{
        x:{title:{display:true,text:'区块高度'}, ticks:{maxTicksLimit:20}},
        y:{title:{display:true,text:'秒'}, beginAtZero:false}
      }
    }
  });
})();
</script>
</body>
</html>`;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filename = `difficulty-window_${startH}_${endH}_${Date.now()}.html`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, html);
    return filepath;
}

function buildStatCards(rows, colorMap) {
    const total   = rows.length;
    const counts  = {};
    let mismatches = 0;
    for (const r of rows) {
        counts[r.reason] = (counts[r.reason] || 0) + 1;
        if (r.match === false) mismatches++;
    }
    const labels = {
        RATE_LIMIT_UP:'↑限速(慢块)', RATE_LIMIT_DN:'↓限速(快块)',
        MTP12_EMERGENCY:'MTP12紧急', DAA_NORMAL:'正常DAA',
        HARDCODED_FORK:'Fork锚点',
    };
    let html = `<div class="stat-card"><div class="val">${total}</div><div class="lbl">分析总块数</div></div>`;
    html    += `<div class="stat-card"><div class="val" style="color:${mismatches?'#e74c3c':'#27ae60'}">${mismatches||'0'}</div><div class="lbl">计算不符块数</div></div>`;
    for (const [reason, count] of Object.entries(counts)) {
        const color = colorMap[reason] || '#95a5a6';
        html += `<div class="stat-card"><div class="val" style="color:${color}">${count}</div><div class="lbl">${labels[reason]||reason}</div></div>`;
    }
    return html;
}

function buildTableRow(r) {
    const fmt   = bits => bits ? '0x'+(bits>>>0).toString(16).padStart(8,'0') : '-';
    const match = r.match === null ? '<span>?</span>'
                : r.match          ? '<span class="match-ok">✓</span>'
                :                    '<span class="match-ng">✗</span>';
    const RLABELS = {
        RATE_LIMIT_UP:'↑限速(慢块降难度被夹)', RATE_LIMIT_DN:'↓限速(快块提难度被夹)',
        MTP12_EMERGENCY:'⚡MTP12紧急', DAA_NORMAL:'○正常DAA', HARDCODED_FORK:'★Fork锚点',
        MISSING_DATA:'?数据缺失', PRE_TBC:'—TBC前',
    };
    return `<tr>
        <td>${r.height}</td>
        <td>${fmt(r.actualBits)}</td>
        <td>${fmt(r.computedBits)}</td>
        <td>${fmt(r.dnBits)}</td>
        <td>${fmt(r.upBits)}</td>
        <td>${r.windowAvgInterval ? r.windowAvgInterval.toFixed(0)+'s' : '-'}</td>
        <td>${r.newBlockSpacing}s</td>
        <td>${(r.mtp12/3600).toFixed(1)}h</td>
        <td class="reason-${r.reason}">${RLABELS[r.reason]||r.reason}</td>
        <td>${match}</td>
      </tr>`;
}

// ── 命令行参数解析 ────────────────────────────────────────────────
function parseArgs() {
    const args   = process.argv.slice(2);
    const config = { rpc: {} };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--start': case '-s': config.start     = parseInt(args[++i]); break;
            case '--end':   case '-e': config.end       = parseInt(args[++i]); break;
            case '--html':             config.html      = true; break;
            case '--chart':            config.chart     = true; break;
            case '--silent':           config.silent    = true; break;
            case '--output-dir': case '-o': config.outputDir = args[++i]; break;
            case '--help': case '-h':  printUsage(); process.exit(0);
        }
    }
    return config;
}

function printUsage() {
    console.log(`
用法: node analyzers/difficulty-window.js [选项]

选项:
  -s, --start <height>   起始区块高度（默认：当前高度-99）
  -e, --end   <height>   结束区块高度（默认：当前最新高度）
      --html             生成 HTML 交互图表报告
      --chart            在终端显示 ASCII 难度图
  -o, --output-dir <dir> HTML 报告输出目录（默认：./reports）

示例:
  node analyzers/difficulty-window.js --start 828400 --end 828446 --html --chart
  node analyzers/difficulty-window.js --start 824190 --end 824300 --html
  ./framework.js difficulty-window --start 828400 --html
`);
}

// ── 导出和独立运行 ────────────────────────────────────────────────
module.exports = {
    info:    ANALYZER_INFO,
    analyze: analyzeDifficultyWindow,
};

if (require.main === module) {
    const config = parseArgs();
    analyzeDifficultyWindow(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
