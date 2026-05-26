/**
 * 分析器: 区块交易森林分析 (TxForest)
 *
 * 功能: 分析指定区块内交易的依赖关系，构建交易森林，并识别交易类型
 *
 * 独立运行: node analyzers/tx-forest.js --block 824190 --html --top 5
 * 框架调用: ./framework.js tx-forest --block 824190 --html
 */

const { RPCClient } = require('../lib/rpc');
const { Reporter } = require('../lib/reporter');
const fs = require('fs');
const path = require('path');

const ANALYZER_INFO = {
    id: 'tx-forest',
    name: '区块交易森林分析',
    description: '分析指定区块内交易依赖关系，构建交易森林（含类型识别）',
    icon: '🌲',
    version: '2.0.0',
    options: [
        { name: 'block',  alias: 'b', type: 'number',  description: '目标区块高度（默认最新区块）', default: null },
        { name: 'top',    alias: 't', type: 'number',  description: '可视化前N棵最大树',            default: 5   },
        { name: 'limit',              type: 'number',  description: '每棵树最多展示节点数',          default: 300 },
        { name: 'html',               type: 'boolean', description: '生成 HTML 报告',               default: false },
    ]
};

// ── 交易类型定义 ────────────────────────────────────────────────────────────────
const TX_TYPES = {
    coinbase:        { label: 'Coinbase',       color: '#f39c12', border: '#e67e22', shape: 'star'    },
    p2pkh:           { label: 'P2PKH',          color: '#3498db', border: '#2980b9', shape: 'dot'     },
    ft_token:        { label: 'FT Token',       color: '#9b59b6', border: '#8e44ad', shape: 'dot'     },
    contract_script: { label: 'Contract',       color: '#e74c3c', border: '#c0392b', shape: 'square'  },
    contract_call:   { label: 'Contract Call',  color: '#e67e22', border: '#d35400', shape: 'square'  },
    custom_script:   { label: 'Custom Script',  color: '#1abc9c', border: '#16a085', shape: 'triangle'},
    split:           { label: 'Split/Fan-out',  color: '#2ecc71', border: '#27ae60', shape: 'diamond' },
    p2sh:            { label: 'P2SH',           color: '#95a5a6', border: '#7f8c8d', shape: 'dot'     },
    unknown:         { label: 'Unknown',        color: '#bdc3c7', border: '#95a5a6', shape: 'dot'     },
};

/**
 * 根据 scriptPubKey 模式识别交易类型
 */
function classifyTx(tx) {
    if (tx.vin?.[0]?.coinbase) return 'coinbase';

    const vouts = tx.vout || [];
    if (vouts.length === 0) return 'unknown';

    const scriptTypes = vouts.map(v => v.scriptPubKey?.type || 'unknown');
    const scriptSizes = vouts.map(v => (v.scriptPubKey?.hex?.length || 0) / 2);

    const hasMultisig        = scriptTypes.includes('multisig');
    const hasLargeNonstd     = scriptTypes.some((t, i) => t === 'nonstandard' && scriptSizes[i] > 100);
    const hasSmallNonstd     = scriptTypes.some((t, i) => t === 'nonstandard' && scriptSizes[i] <= 100);
    const nulldataIdx        = scriptTypes.findIndex(t => t === 'nulldata');
    const nulldataSize       = nulldataIdx >= 0 ? scriptSizes[nulldataIdx] : 0;
    const has38B             = scriptSizes.some((s, i) => scriptTypes[i] === 'pubkeyhash' && s >= 36 && s <= 40);
    const hasScripthash      = scriptTypes.includes('scripthash');
    const allPubkeyhash25    = scriptTypes.every(t => t === 'pubkeyhash') && scriptSizes.every(s => s === 25);
    const manyOutputs        = vouts.length >= 5 && scriptTypes.filter(t => t === 'pubkeyhash').length >= 4;

    if (hasMultisig) return 'custom_script';
    if (hasLargeNonstd) return 'contract_script';   // TBC20 script型 / 大型合约
    if (nulldataSize > 100) return 'contract_call';  // TBC20_CONTRACT
    if (has38B && nulldataSize >= 60 && nulldataSize <= 90) return 'ft_token'; // FT简单转账
    if (hasSmallNonstd && nulldataSize > 50) return 'custom_script'; // OTHER/自定义脚本
    if (hasScripthash) return 'p2sh';
    if (manyOutputs) return 'split';
    return 'p2pkh';
}

// ── 图构建 ───────────────────────────────────────────────────────────────────────
function buildGraph(txs) {
    const txidSet = new Set(txs.map(tx => tx.txid));
    const nodes   = new Map();
    // txDetail: txid → 用于侧边栏展示的完整数据
    const txDetail = new Map();

    for (const tx of txs) {
        // 构建详情记录（vout脚本、vin来源）
        txDetail.set(tx.txid, {
            txid:    tx.txid,
            vsize:   tx.vsize || tx.size || 0,
            version: tx.version,
            locktime:tx.locktime,
            vin: (tx.vin || []).map(v => ({
                coinbase: v.coinbase || null,
                txid:     v.txid   || null,
                vout:     v.vout   != null ? v.vout : null,
                sequence: v.sequence,
            })),
            vout: (tx.vout || []).map(v => ({
                n:     v.n,
                value: v.value,
                type:  v.scriptPubKey?.type  || 'unknown',
                asm:   v.scriptPubKey?.asm   || '',
                hex:   v.scriptPubKey?.hex   || '',
                size:  (v.scriptPubKey?.hex?.length || 0) / 2,
            })),
        });

        if (!nodes.has(tx.txid)) {
            nodes.set(tx.txid, {
                txid:     tx.txid,
                parents:  new Set(),
                children: new Set(),
                txType:   classifyTx(tx),
                vinCount: (tx.vin || []).length,
                voutCount:(tx.vout || []).length,
                vsize:    tx.vsize || tx.size || 0,
            });
        }

        const node = nodes.get(tx.txid);

        for (const vin of (tx.vin || [])) {
            if (vin.coinbase) continue;
            if (vin.txid && txidSet.has(vin.txid)) {
                node.parents.add(vin.txid);
                if (!nodes.has(vin.txid)) {
                    nodes.set(vin.txid, {
                        txid: vin.txid, parents: new Set(), children: new Set(),
                        txType: 'unknown', vinCount: 0, voutCount: 0, vsize: 0,
                    });
                }
                nodes.get(vin.txid).children.add(tx.txid);
            }
        }
    }

    const edges = [];
    for (const [, node] of nodes) {
        for (const parentTxid of node.parents) {
            edges.push({ from: parentTxid, to: node.txid });
        }
    }

    const roots = [];
    for (const [txid, node] of nodes) {
        if (node.parents.size === 0) roots.push(txid);
    }

    return { nodes, edges, roots, txDetail };
}

function buildTrees(nodes, roots) {
    const depth = new Map();
    for (const txid of nodes.keys()) depth.set(txid, 0);

    const trees = [];
    for (const rootTxid of roots) {
        const reachable = new Set();
        const queue = [{ txid: rootTxid, d: 0 }];
        while (queue.length > 0) {
            const { txid, d } = queue.shift();
            if (reachable.has(txid)) {
                if (d > depth.get(txid)) {
                    depth.set(txid, d);
                    for (const child of nodes.get(txid).children) queue.push({ txid: child, d: d + 1 });
                }
                continue;
            }
            reachable.add(txid);
            if (d > depth.get(txid)) depth.set(txid, d);
            for (const child of nodes.get(txid).children) queue.push({ txid: child, d: d + 1 });
        }
        const maxDepth = Math.max(...Array.from(reachable).map(t => depth.get(t)));
        trees.push({ root: rootTxid, nodes: reachable, size: reachable.size, maxDepth: maxDepth >= 0 ? maxDepth : 0 });
    }
    trees.sort((a, b) => b.size - a.size);
    return { trees, depth };
}

// ── 主分析函数 ────────────────────────────────────────────────────────────────────
async function analyzeTxForest(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    const latestHeight = await rpc.getBlockCount();
    const blockHeight  = config.block != null ? config.block : latestHeight;

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('目标区块', blockHeight);
    reporter.log('  正在获取区块数据（verbosity=2）...');

    const block = await rpc.getBlock(blockHeight, 2);
    if (!block?.tx?.length) throw new Error(`无法获取区块 ${blockHeight} 的交易数据`);

    const txs = block.tx;
    reporter.kv('交易总数', txs.length);
    reporter.kv('区块哈希', block.hash);

    reporter.log('  正在构建交易依赖图...');
    const { nodes, edges, roots, txDetail } = buildGraph(txs);

    reporter.log('  正在分析树结构...');
    const { trees, depth } = buildTrees(nodes, roots);

    const multiParentCount = Array.from(nodes.values()).filter(n => n.parents.size > 1).length;
    const isolatedCount    = trees.filter(t => t.size === 1).length;
    const nonTrivialTrees  = trees.filter(t => t.size > 1);

    // 类型分布统计
    const typeDist = {};
    for (const node of nodes.values()) {
        typeDist[node.txType] = (typeDist[node.txType] || 0) + 1;
    }

    reporter.section('森林统计');
    reporter.kv('根交易数（树的数量）', roots.length);
    reporter.kv('独立交易（无区块内依赖）', isolatedCount);
    reporter.kv('非平凡树（含子孙）', nonTrivialTrees.length);
    reporter.kv('多父节点交易', multiParentCount);
    reporter.kv('总有向边数', edges.length);
    if (trees.length > 0) {
        reporter.kv('最大树节点数', trees[0].size);
        reporter.kv('最大树深度', trees[0].maxDepth);
    }

    reporter.section('交易类型分布');
    for (const [type, count] of Object.entries(typeDist).sort((a, b) => b[1] - a[1])) {
        const label = TX_TYPES[type]?.label || type;
        reporter.kv(label, count);
    }

    const topDisplay = Math.min(10, nonTrivialTrees.length);
    if (topDisplay > 0) {
        reporter.section(`最大的 ${topDisplay} 棵树`);
        nonTrivialTrees.slice(0, topDisplay).forEach((tree, i) => {
            const rootNode = nodes.get(tree.root);
            const typeLabel = TX_TYPES[rootNode?.txType]?.label || rootNode?.txType || '?';
            reporter.kv(`树 #${(i + 1).toString().padStart(2)}`, `大小=${tree.size} 节点, 深度=${tree.maxDepth}, 根类型=${typeLabel}, 根=${tree.root.slice(0, 12)}...`);
        });
    }

    const result = {
        info:   ANALYZER_INFO,
        config: { blockHeight },
        data: {
            blockHeight, blockHash: block.hash, totalTx: txs.length,
            trees, nodes, edges, depth, typeDist, txDetail,
            multiParentCount, isolatedCount, nonTrivialTrees,
            stats: {
                treeCount: roots.length, isolatedCount, nonTrivialCount: nonTrivialTrees.length,
                multiParentCount, edgeCount: edges.length,
                largestTreeSize: trees[0]?.size || 0, largestTreeDepth: trees[0]?.maxDepth || 0,
            }
        }
    };

    if (config.html) {
        const nodeLimit = config.limit != null ? Number(config.limit) : 500;
        const htmlPath  = generateHTMLReport(result, nodeLimit, config.outputDir || './reports');
        reporter.log(`\n📄 HTML 报告已保存: ${htmlPath}`);
        result.htmlPath = htmlPath;
    }

    return result;
}

// ── HTML 报告生成（单图展示全部森林）────────────────────────────────────────────
function generateHTMLReport(result, nodeLimit, outputDir) {
    const { blockHeight, blockHash, totalTx, nodes, edges, depth, typeDist, stats, nonTrivialTrees, trees, txDetail } = result.data;

    // 构建给前端用的 txDetail JSON：txid → 详情对象（含父子列表）
    const detailMap = {};
    for (const [txid, detail] of txDetail) {
        const node = nodes.get(txid);
        detailMap[txid] = {
            ...detail,
            txType:   node?.txType   || 'unknown',
            parents:  node ? Array.from(node.parents)  : [],
            children: node ? Array.from(node.children) : [],
        };
    }
    const txDetailJson = JSON.stringify(detailMap);

    // 类型分布图数据
    const typeEntries = Object.entries(typeDist).sort((a, b) => b[1] - a[1]);
    const typeLabels  = JSON.stringify(typeEntries.map(([t]) => TX_TYPES[t]?.label || t));
    const typeValues  = JSON.stringify(typeEntries.map(([, c]) => c));
    const typeColors  = JSON.stringify(typeEntries.map(([t]) => TX_TYPES[t]?.color || '#bdc3c7'));

    // 图例 HTML
    const activeTypes = new Set(Object.keys(typeDist));
    const legendItems = Object.entries(TX_TYPES)
        .filter(([k]) => activeTypes.has(k))
        .map(([, info]) =>
            `<div class="legend-item">
                <div class="legend-dot" style="background:${info.color};border:2px solid ${info.border}"></div>
                <span>${info.label}</span>
            </div>`
        ).join('');

    // 构建整个森林的单张 vis.js 图
    const { visNodesJson, visEdgesJson, truncated } = buildForestNetwork(nodes, edges, depth, nodeLimit);

    // 树摘要列表（点击 → 选中节点 + 打开侧边栏）
    const treeRows = trees.slice(0, 30).map((tree, i) => {
        const rootNode = nodes.get(tree.root);
        const typeInfo = TX_TYPES[rootNode?.txType] || TX_TYPES.unknown;
        return `<tr class="clickable-row" data-txid="${tree.root}" onclick="selectTx('${tree.root}')">
            <td>${i + 1}</td>
            <td><span class="type-badge" style="background:${typeInfo.color}">${typeInfo.label}</span></td>
            <td><code title="${tree.root}">${tree.root.slice(0, 20)}…</code></td>
            <td>${tree.size}</td>
            <td>${tree.maxDepth}</td>
        </tr>`;
    }).join('\n');

    const truncNote = truncated ? `<p style="color:#e67e22;font-size:13px;margin:8px 0 0">⚠ 节点数超过 ${nodeLimit}，已截断显示</p>` : '';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>区块 #${blockHeight} 交易森林</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/vis-network@9/dist/vis-network.min.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/vis-network@9/dist/dist/vis-network.min.css">
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
               margin: 0; padding: 20px; background: #f0f2f5; color: #333; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                  color: white; padding: 24px 30px; border-radius: 12px; margin-bottom: 20px; }
        .header h1 { margin: 0 0 6px; font-size: 22px; }
        .header p  { margin: 0; opacity: 0.75; font-size: 12px; font-family: monospace; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
                      gap: 12px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 14px 16px; border-radius: 10px;
                     box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
        .stat-card .val { font-size: 24px; font-weight: 700; color: #0f3460; }
        .stat-card .lbl { font-size: 11px; color: #999; margin-top: 3px; }
        .panel-row { display: grid; grid-template-columns: 260px 1fr; gap: 20px; margin-bottom: 20px; }
        .section { background: white; padding: 18px 22px; border-radius: 12px;
                   box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
        .section h2 { margin: 0 0 12px; font-size: 15px; color: #444;
                      border-bottom: 1px solid #f0f0f0; padding-bottom: 8px; }
        .chart-wrap { height: 180px; }
        .legend { display: flex; flex-direction: column; gap: 8px; }
        .legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
        .legend-dot { width: 13px; height: 13px; border-radius: 2px; flex-shrink: 0; }
        /* 主森林图 */
        .forest-section { background: white; border-radius: 12px;
                          box-shadow: 0 2px 6px rgba(0,0,0,0.06); margin-bottom: 20px; overflow: hidden; }
        .forest-header { padding: 14px 22px; border-bottom: 1px solid #f0f0f0;
                         display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
        .forest-header h2 { margin: 0; font-size: 16px; color: #444; flex: 1; }
        .forest-controls { display: flex; gap: 8px; }
        .btn { padding: 5px 14px; border-radius: 6px; border: 1px solid #ddd; background: white;
               font-size: 12px; cursor: pointer; color: #555; }
        .btn:hover { background: #f5f5f5; }
        #forest-net { width: 100%; height: 680px; background: #fafafa; }
        /* 树列表 */
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #f5f5f5; }
        th { background: #f7f8fa; font-weight: 600; color: #666; font-size: 11px; }
        tr:hover { background: #fafafa; }
        .type-badge { color: white; padding: 1px 7px; border-radius: 8px; font-size: 10px; font-weight: 600; }
        code { font-family: 'SF Mono', Consolas, monospace; font-size: 11px; color: #0f3460; }
        .hint { font-size: 12px; color: #aaa; margin: 6px 0 0; }
        .clickable-row { cursor: pointer; }
        .clickable-row:hover td { background: #e8f4ff; }
        .clickable-row.selected td { background: #d0eaff; font-weight: 600; }
        /* 侧边栏 */
        #sidebar { position: fixed; top: 0; right: -480px; width: 460px; height: 100vh;
                   background: white; box-shadow: -4px 0 20px rgba(0,0,0,0.15);
                   z-index: 1000; transition: right 0.25s ease; display: flex; flex-direction: column; }
        #sidebar.open { right: 0; }
        #sidebar-header { padding: 16px 18px; background: #0f3460; color: white;
                          display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        #sidebar-header h3 { margin: 0; font-size: 15px; flex: 1; }
        #sidebar-close { background: none; border: none; color: white; font-size: 20px;
                         cursor: pointer; padding: 0 4px; line-height: 1; }
        #sidebar-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
        .sb-section { margin-bottom: 18px; }
        .sb-label { font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase;
                    letter-spacing: 0.5px; margin-bottom: 6px; }
        .txid-row { display: flex; align-items: center; gap: 8px; }
        .txid-full { font-family: monospace; font-size: 12px; color: #0f3460; word-break: break-all;
                     flex: 1; background: #f5f7fa; padding: 6px 10px; border-radius: 6px; }
        .copy-btn { flex-shrink: 0; padding: 5px 10px; border: 1px solid #ddd; border-radius: 6px;
                    background: white; font-size: 11px; cursor: pointer; color: #555; }
        .copy-btn:hover { background: #f0f0f0; }
        .copy-btn.copied { background: #27ae60; color: white; border-color: #27ae60; }
        .tx-link { display: flex; align-items: center; gap: 6px; padding: 5px 0;
                   border-bottom: 1px solid #f5f5f5; }
        .tx-link code { flex: 1; font-size: 11px; color: #0f3460; word-break: break-all; }
        .tx-link .copy-btn { flex-shrink: 0; }
        .tx-link .nav-btn { flex-shrink: 0; padding: 3px 8px; border: 1px solid #3498db;
                            border-radius: 4px; background: white; font-size: 10px;
                            cursor: pointer; color: #3498db; }
        .tx-link .nav-btn:hover { background: #3498db; color: white; }
        .script-block { background: #1a1a2e; color: #a8d8a8; font-family: monospace;
                        font-size: 10px; padding: 10px 12px; border-radius: 6px;
                        word-break: break-all; white-space: pre-wrap; max-height: 120px;
                        overflow-y: auto; margin-top: 4px; }
        .vout-row { border: 1px solid #f0f0f0; border-radius: 6px; padding: 8px 10px;
                    margin-bottom: 8px; }
        .vout-row .vout-meta { display: flex; gap: 10px; font-size: 12px; color: #555;
                               margin-bottom: 6px; flex-wrap: wrap; }
        .vout-row .vout-meta span { background: #f5f7fa; padding: 2px 7px; border-radius: 4px; }
        .hex-toggle { font-size: 10px; color: #3498db; cursor: pointer; margin-top: 4px;
                      display: inline-block; }
    </style>
</head>
<body>
<div class="container">

    <div class="header">
        <h1>🌲 区块 #${blockHeight} 交易森林</h1>
        <p>${blockHash} &nbsp;·&nbsp; ${new Date().toLocaleString('zh-CN')}</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="val">${totalTx}</div><div class="lbl">区块总交易数</div></div>
        <div class="stat-card"><div class="val">${stats.treeCount}</div><div class="lbl">依赖树（根节点）</div></div>
        <div class="stat-card"><div class="val">${stats.nonTrivialCount}</div><div class="lbl">非平凡树</div></div>
        <div class="stat-card"><div class="val">${stats.isolatedCount}</div><div class="lbl">独立交易</div></div>
        <div class="stat-card"><div class="val">${stats.edgeCount}</div><div class="lbl">区块内依赖边</div></div>
        <div class="stat-card"><div class="val">${stats.multiParentCount}</div><div class="lbl">多父节点</div></div>
        <div class="stat-card"><div class="val">${stats.largestTreeSize}</div><div class="lbl">最大树节点数</div></div>
        <div class="stat-card"><div class="val">${stats.largestTreeDepth}</div><div class="lbl">最大树深度</div></div>
    </div>

    <div class="panel-row">
        <div>
            <div class="section" style="margin-bottom:16px">
                <h2>交易类型分布</h2>
                <div class="chart-wrap"><canvas id="typeChart"></canvas></div>
            </div>
            <div class="section">
                <h2>图例</h2>
                <div class="legend">${legendItems}</div>
                <p class="hint">◇ 菱形 = Split/Fan-out &nbsp; ■ 方形 = Contract<br>
                ▲ 三角 = Custom Script &nbsp; ★ 星形 = Coinbase<br>
                白色边框 = 根节点（无区块内父交易）</p>
            </div>
        </div>

        <div class="section">
            <h2>树摘要（前 ${Math.min(trees.length, 30)} 棵）</h2>
            <table>
                <thead><tr><th>#</th><th>根节点类型</th><th>根交易ID</th><th>节点数</th><th>深度</th></tr></thead>
                <tbody>${treeRows}</tbody>
            </table>
        </div>
    </div>

    <div class="forest-section">
        <div class="forest-header">
            <h2>🌳 区块内完整交易森林（单图）</h2>
            <div class="forest-controls">
                <button class="btn" onclick="netFit()">适应窗口</button>
                <button class="btn" onclick="netZoomIn()">放大 +</button>
                <button class="btn" onclick="netZoomOut()">缩小 −</button>
            </div>
            <span style="font-size:12px;color:#aaa">左右滑动可查看完整树链；悬停节点查看详情；滚轮缩放</span>
        </div>
        ${truncNote}
        <div id="forest-net"></div>
    </div>

</div>

<!-- 侧边栏 -->
<div id="sidebar">
    <div id="sidebar-header">
        <h3 id="sb-title">交易详情</h3>
        <button id="sidebar-close" onclick="closeSidebar()">✕</button>
    </div>
    <div id="sidebar-body"></div>
</div>

<script>
// 类型分布甜甜圈图
(function() {
    const ctx = document.getElementById('typeChart');
    if (!ctx) return;
    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ${typeLabels},
            datasets: [{ data: ${typeValues}, backgroundColor: ${typeColors}, borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } }
        }
    });
})();

// 森林网络图
let _network;
(function() {
    const container = document.getElementById('forest-net');
    if (!container) return;
    const nodes = new vis.DataSet(${visNodesJson});
    const edges = new vis.DataSet(${visEdgesJson});
    _network = new vis.Network(container, { nodes, edges }, {
        layout: {
            hierarchical: {
                enabled:              true,
                direction:            'LR',
                sortMethod:           'directed',
                levelSeparation:      130,
                nodeSpacing:          60,
                treeSpacing:          80,
                blockShifting:        true,
                edgeMinimization:     true,
                parentCentralization: true,
            }
        },
        physics: { enabled: false },
        interaction: {
            hover:             true,
            navigationButtons: false,
            keyboard:          false,
            tooltipDelay:      60,
            zoomView:          true,
            dragView:          true,
        },
        nodes: {
            borderWidth: 1.5,
            shadow: { enabled: true, size: 3, x: 1, y: 2, color: 'rgba(0,0,0,0.12)' }
        },
        edges: {
            smooth: { type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.25 }
        },
    });
})();
function netFit()     { _network && _network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } }); }
function netZoomIn()  { _network && _network.moveTo({ scale: _network.getScale() * 1.3 }); }
function netZoomOut() { _network && _network.moveTo({ scale: _network.getScale() / 1.3 }); }

// ── 交易详情侧边栏 ────────────────────────────────────────────────────────────
const TX_DETAIL = ${txDetailJson};
const TX_TYPES_CLIENT = ${JSON.stringify(TX_TYPES)};

let _selectedTxid = null;

// vis.js 节点点击 → 打开侧边栏
if (_network) {
    _network.on('click', function(params) {
        if (params.nodes.length > 0) {
            selectTx(params.nodes[0]);
        }
    });
}

function selectTx(txid) {
    // 高亮表格行
    document.querySelectorAll('.clickable-row').forEach(r => {
        r.classList.toggle('selected', r.dataset.txid === txid);
    });
    // 让 vis.js 选中并居中
    if (_network) {
        _network.selectNodes([txid]);
        _network.focus(txid, { scale: Math.max(_network.getScale(), 1.0), animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    }
    _selectedTxid = txid;
    renderSidebar(txid);
    document.getElementById('sidebar').classList.add('open');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    if (_network) _network.unselectAll();
    document.querySelectorAll('.clickable-row').forEach(r => r.classList.remove('selected'));
    _selectedTxid = null;
}

function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        if (btn) { btn.textContent = '已复制'; btn.classList.add('copied');
            setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1500); }
    });
}

function renderSidebar(txid) {
    const d = TX_DETAIL[txid];
    const sb = document.getElementById('sidebar-body');
    if (!d) { sb.innerHTML = '<p style="color:#aaa;padding:20px">暂无详情数据</p>'; return; }

    const typeInfo = TX_TYPES_CLIENT[d.txType] || TX_TYPES_CLIENT.unknown;
    document.getElementById('sb-title').textContent = '交易详情';

    // txid 行
    let html = \`<div class="sb-section">
        <div class="sb-label">TXID</div>
        <div class="txid-row">
            <div class="txid-full" id="sb-txid">\${txid}</div>
            <button class="copy-btn" onclick="copyText('\${txid}', this)">复制</button>
        </div>
    </div>\`;

    // 基本信息
    html += \`<div class="sb-section">
        <div class="sb-label">基本信息</div>
        <table style="width:100%;font-size:12px;border-collapse:collapse">
            <tr><td style="color:#999;padding:3px 0;width:80px">类型</td>
                <td><span class="type-badge" style="background:\${typeInfo.color}">\${typeInfo.label}</span></td></tr>
            <tr><td style="color:#999;padding:3px 0">大小</td><td>\${d.vsize} B</td></tr>
            <tr><td style="color:#999;padding:3px 0">输入数</td><td>\${d.vin.length}</td></tr>
            <tr><td style="color:#999;padding:3px 0">输出数</td><td>\${d.vout.length}</td></tr>
            <tr><td style="color:#999;padding:3px 0">Version</td><td>\${d.version}</td></tr>
            <tr><td style="color:#999;padding:3px 0">Locktime</td><td>\${d.locktime}</td></tr>
        </table>
    </div>\`;

    // 父交易（区块内）
    if (d.parents.length > 0) {
        html += \`<div class="sb-section">
            <div class="sb-label">父交易（区块内依赖，共 \${d.parents.length} 笔）</div>\`;
        d.parents.forEach(pid => {
            html += \`<div class="tx-link">
                <code>\${pid}</code>
                <button class="copy-btn" onclick="copyText('\${pid}',this)">复制</button>
                <button class="nav-btn" onclick="selectTx('\${pid}')">查看</button>
            </div>\`;
        });
        html += \`</div>\`;
    } else {
        html += \`<div class="sb-section">
            <div class="sb-label">父交易</div>
            <p style="font-size:12px;color:#aaa;margin:4px 0">无区块内父交易（根节点）</p>
        </div>\`;
    }

    // 子交易（区块内）
    if (d.children.length > 0) {
        html += \`<div class="sb-section">
            <div class="sb-label">子交易（区块内，共 \${d.children.length} 笔）</div>\`;
        d.children.forEach(cid => {
            html += \`<div class="tx-link">
                <code>\${cid}</code>
                <button class="copy-btn" onclick="copyText('\${cid}',this)">复制</button>
                <button class="nav-btn" onclick="selectTx('\${cid}')">查看</button>
            </div>\`;
        });
        html += \`</div>\`;
    }

    // 输入列表
    html += \`<div class="sb-section">
        <div class="sb-label">输入（VIN）</div>\`;
    d.vin.forEach((v, i) => {
        if (v.coinbase) {
            html += \`<div class="tx-link"><code style="color:#f39c12">coinbase: \${v.coinbase.slice(0, 40)}…</code></div>\`;
        } else {
            html += \`<div class="tx-link">
                <code>[\${i}] \${v.txid ? v.txid.slice(0,16)+'…' : '?'}:\${v.vout}</code>
                \${v.txid ? \`<button class="copy-btn" onclick="copyText('\${v.txid}',this)">复制txid</button>\` : ''}
                \${v.txid && TX_DETAIL[v.txid] ? \`<button class="nav-btn" onclick="selectTx('\${v.txid}')">查看</button>\` : ''}
            </div>\`;
        }
    });
    html += \`</div>\`;

    // 输出列表（含脚本）
    html += \`<div class="sb-section">
        <div class="sb-label">输出（VOUT）</div>\`;
    d.vout.forEach(v => {
        const satStr = v.value != null ? (v.value * 1e8).toFixed(0) + ' sat' : '';
        const asmShort = v.asm.length > 100 ? v.asm.slice(0, 100) + '…' : v.asm;
        const hexId = 'hex_' + txid.slice(0,8) + '_' + v.n;
        html += \`<div class="vout-row">
            <div class="vout-meta">
                <span>#\${v.n}</span>
                <span>\${v.type}</span>
                <span>\${v.size} B</span>
                \${satStr ? \`<span>\${satStr}</span>\` : ''}
            </div>
            <div style="font-size:11px;color:#666;word-break:break-all">\${asmShort}</div>
            \${v.hex ? \`<span class="hex-toggle" onclick="toggleHex('\${hexId}')">▶ 原始 Hex</span>
            <div id="\${hexId}" class="script-block" style="display:none">\${v.hex}</div>
            <button class="copy-btn" style="margin-top:4px;font-size:10px" onclick="copyText('\${v.hex}',this)">复制 Hex</button>\` : ''}
        </div>\`;
    });
    html += \`</div>\`;

    sb.innerHTML = html;
}

function toggleHex(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ESC 键关闭侧边栏
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
</script>
</body>
</html>`;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filename = `tx-forest_${blockHeight}_${Date.now()}.html`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, html, 'utf8');
    return filepath;
}

/**
 * 构建全森林 vis.js 节点和边数据（所有树合并到单图）
 */
function buildForestNetwork(nodes, edges, depth, nodeLimit) {
    // 若节点过多，按深度优先保留前 nodeLimit 个
    let visibleTxids;
    if (nodes.size > nodeLimit) {
        const sorted = Array.from(nodes.keys()).sort((a, b) => (depth.get(a) || 0) - (depth.get(b) || 0));
        visibleTxids = new Set(sorted.slice(0, nodeLimit));
    } else {
        visibleTxids = new Set(nodes.keys());
    }

    const visNodes = [];
    const visEdges = [];
    const edgeSeen = new Set();

    for (const txid of visibleTxids) {
        const node     = nodes.get(txid);
        const d        = depth.get(txid) || 0;
        const typeInfo = TX_TYPES[node.txType] || TX_TYPES.unknown;
        const isRoot   = node.parents.size === 0;
        const isMultiP = node.parents.size > 1;
        const short    = txid.slice(0, 8) + '…';

        visNodes.push({
            id:    txid,
            label: `${typeInfo.label}\n${short}`,
            title: `<b>${typeInfo.label}</b><br>` +
                   `txid: <code>${txid}</code><br>` +
                   `深度: ${d} &nbsp; 父: ${node.parents.size} &nbsp; 子: ${node.children.size}<br>` +
                   `输入: ${node.vinCount} &nbsp; 输出: ${node.voutCount} &nbsp; ${node.vsize}B`,
            color: {
                background: typeInfo.color,
                border:     isRoot ? '#ffffff' : typeInfo.border,
                highlight:  { background: typeInfo.color, border: '#fff' },
                hover:      { background: typeInfo.color, border: '#fff' },
            },
            borderWidth:         isRoot ? 3 : 1.5,
            borderWidthSelected: 3,
            level: d,
            font:  { color: '#fff', size: 11, bold: isRoot },
            shape: typeInfo.shape,
            size:  isRoot ? 20 : (isMultiP ? 14 : 11),
        });

        for (const parentTxid of node.parents) {
            if (visibleTxids.has(parentTxid)) {
                const key = `${parentTxid}→${txid}`;
                if (!edgeSeen.has(key)) {
                    edgeSeen.add(key);
                    visEdges.push({
                        from:   parentTxid,
                        to:     txid,
                        arrows: { to: { enabled: true, scaleFactor: 0.6 } },
                        color:  { color: '#ccc', highlight: '#888', hover: '#888', opacity: 0.85 },
                        width:  isMultiP ? 2 : 1,
                    });
                }
            }
        }
    }

    return {
        visNodesJson: JSON.stringify(visNodes),
        visEdgesJson: JSON.stringify(visEdges),
        truncated:    nodes.size > nodeLimit,
    };
}

// ── 命令行 ────────────────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const config = { rpc: {} };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--block':  case '-b': config.block     = parseInt(args[++i]); break;
            case '--limit':             config.limit     = parseInt(args[++i]); break;
            case '--html':              config.html      = true;                break;
            case '--output-dir': case '-o': config.outputDir = args[++i];       break;
            case '--rpc-url':   config.rpc.url      = args[++i]; break;
            case '--rpc-user':  config.rpc.username = args[++i]; break;
            case '--rpc-pass':  config.rpc.password = args[++i]; break;
            case '--silent':    config.silent = true; break;
        }
    }
    return config;
}

module.exports = { info: ANALYZER_INFO, analyze: analyzeTxForest };

if (require.main === module) {
    const config = parseArgs();
    analyzeTxForest(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
