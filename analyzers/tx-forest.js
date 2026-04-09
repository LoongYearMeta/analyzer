/**
 * 分析器: 区块交易森林分析 (TxForest)
 *
 * 功能: 分析指定区块内交易的依赖关系，构建交易森林
 *   - 森林 = 一组树的集合，每棵树以一个"根交易"（无区块内父交易）为祖先
 *   - 若某子孙交易有多个区块内父交易，则连线到所有父交易（DAG结构）
 *
 * 独立运行: node analyzers/tx-forest.js --block 824190 --html --top 5
 * 框架调用: ./framework.js tx-forest --block 824190 --html
 */

const { RPCClient } = require('../lib/rpc');
const { Reporter } = require('../lib/reporter');
const fs = require('fs');
const path = require('path');

// ============ 分析器信息 ============
const ANALYZER_INFO = {
    id: 'tx-forest',
    name: '区块交易森林分析',
    description: '分析指定区块内交易依赖关系，构建交易森林（父子依赖DAG）',
    icon: '🌲',
    version: '1.0.0',
    options: [
        { name: 'block', alias: 'b', type: 'number', description: '目标区块高度（默认最新区块）', default: null },
        { name: 'top',   alias: 't', type: 'number', description: '可视化前N棵最大树',            default: 5  },
        { name: 'limit', type: 'number', description: '每棵树最多展示节点数（防止过大）', default: 300 },
        { name: 'html',  type: 'boolean', description: '生成 HTML 报告',                          default: false },
    ]
};

// ============ 核心分析逻辑 ============

/**
 * 构建区块内交易依赖图
 * @returns {{ nodes: Map, edges: Array, roots: Array }}
 */
function buildGraph(txs) {
    const txidSet = new Set(txs.map(tx => tx.txid));

    // nodes: txid -> { txid, parents: Set<txid>, children: Set<txid>, isCoinbase, vsize }
    const nodes = new Map();

    for (const tx of txs) {
        if (!nodes.has(tx.txid)) {
            nodes.set(tx.txid, {
                txid:       tx.txid,
                parents:    new Set(),
                children:   new Set(),
                isCoinbase: false,
                vsize:      tx.vsize || tx.size || 0,
                weight:     tx.weight || 0,
            });
        }

        const node = nodes.get(tx.txid);

        for (const vin of (tx.vin || [])) {
            if (vin.coinbase) {
                node.isCoinbase = true;
                continue;
            }
            if (vin.txid && txidSet.has(vin.txid)) {
                // vin.txid -> tx.txid 的有向依赖边（父 -> 子）
                node.parents.add(vin.txid);

                if (!nodes.has(vin.txid)) {
                    nodes.set(vin.txid, {
                        txid:       vin.txid,
                        parents:    new Set(),
                        children:   new Set(),
                        isCoinbase: false,
                        vsize:      0,
                        weight:     0,
                    });
                }
                nodes.get(vin.txid).children.add(tx.txid);
            }
        }
    }

    // 收集所有有向边
    const edges = [];
    for (const [txid, node] of nodes) {
        for (const parentTxid of node.parents) {
            edges.push({ from: parentTxid, to: txid });
        }
    }

    // 找根节点（无区块内父交易）
    const roots = [];
    for (const [txid, node] of nodes) {
        if (node.parents.size === 0) {
            roots.push(txid);
        }
    }

    return { nodes, edges, roots };
}

/**
 * 从每个根出发 BFS，收集可达节点集合（即该根的"树"），并计算每个节点的最大深度
 */
function buildTrees(nodes, roots) {
    // depth[txid] = 从任意根出发到达该节点的最大深度
    const depth = new Map();
    for (const txid of nodes.keys()) depth.set(txid, 0);

    const trees = [];

    for (const rootTxid of roots) {
        const reachable = new Set();
        const queue = [{ txid: rootTxid, d: 0 }];

        while (queue.length > 0) {
            const { txid, d } = queue.shift();
            if (reachable.has(txid)) {
                // 已访问，但可能通过更长路径再访问 -> 只更新深度
                if (d > depth.get(txid)) {
                    depth.set(txid, d);
                    // 需继续传播更深的深度
                    for (const child of nodes.get(txid).children) {
                        queue.push({ txid: child, d: d + 1 });
                    }
                }
                continue;
            }

            reachable.add(txid);
            if (d > depth.get(txid)) depth.set(txid, d);

            for (const child of nodes.get(txid).children) {
                queue.push({ txid: child, d: d + 1 });
            }
        }

        const maxDepth = Math.max(...Array.from(reachable).map(t => depth.get(t)));
        trees.push({
            root:     rootTxid,
            nodes:    reachable,
            size:     reachable.size,
            maxDepth: maxDepth >= 0 ? maxDepth : 0,
        });
    }

    // 按节点数降序排列
    trees.sort((a, b) => b.size - a.size);
    return { trees, depth };
}

async function analyzeTxForest(config = {}) {
    const rpc = new RPCClient(config.rpc);
    const reporter = new Reporter({ silent: config.silent });

    const latestHeight = await rpc.getBlockCount();
    const blockHeight  = config.block != null ? config.block : latestHeight;

    reporter.title(`${ANALYZER_INFO.icon} ${ANALYZER_INFO.name}`);
    reporter.kv('目标区块', blockHeight);

    // 获取完整区块（verbosity=2 包含所有交易的完整输入输出）
    reporter.log('  正在获取区块数据（verbosity=2）...');
    const block = await rpc.getBlock(blockHeight, 2);

    if (!block || !block.tx || block.tx.length === 0) {
        throw new Error(`无法获取区块 ${blockHeight} 的交易数据`);
    }

    const txs = block.tx;
    reporter.kv('交易总数', txs.length);
    reporter.kv('区块哈希', block.hash);

    // 构建依赖图
    reporter.log('  正在构建交易依赖图...');
    const { nodes, edges, roots } = buildGraph(txs);

    // 构建树（BFS 计算可达集合）
    reporter.log('  正在分析树结构...');
    const { trees, depth } = buildTrees(nodes, roots);

    // 统计
    const multiParentCount = Array.from(nodes.values()).filter(n => n.parents.size > 1).length;
    const isolatedCount    = trees.filter(t => t.size === 1).length;
    const nonTrivialTrees  = trees.filter(t => t.size > 1);

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

    // 打印 Top-10 非平凡树
    const topDisplay = Math.min(10, nonTrivialTrees.length);
    if (topDisplay > 0) {
        reporter.section(`最大的 ${topDisplay} 棵树`);
        nonTrivialTrees.slice(0, topDisplay).forEach((tree, i) => {
            const short = tree.root.slice(0, 12) + '...';
            reporter.kv(`树 #${(i + 1).toString().padStart(2)}`, `大小=${tree.size} 节点, 深度=${tree.maxDepth}, 根=${short}`);
        });
    }

    // 树大小分布（ASCII 柱状图）
    const sizeRanges = [
        { min: 2,  max: 5,        label: '2-5'     },
        { min: 6,  max: 10,       label: '6-10'    },
        { min: 11, max: 20,       label: '11-20'   },
        { min: 21, max: 50,       label: '21-50'   },
        { min: 51, max: 100,      label: '51-100'  },
        { min: 101, max: Infinity, label: '>100'   },
    ];
    const sizeDist = sizeRanges.map(r => ({
        label: r.label,
        value: nonTrivialTrees.filter(t => t.size >= r.min && t.size <= r.max).length
    })).filter(d => d.value > 0);

    if (sizeDist.length > 0) {
        reporter.section('非平凡树大小分布');
        const maxVal = Math.max(...sizeDist.map(d => d.value));
        const barW = 40;
        sizeDist.forEach(d => {
            const bar = '█'.repeat(Math.round((d.value / maxVal) * barW));
            reporter.log(`  ${d.label.padStart(6)} │${bar.padEnd(barW)} ${d.value}`);
        });
    }

    // ============ 构建返回数据 ============
    const result = {
        info:   ANALYZER_INFO,
        config: { blockHeight },
        data: {
            blockHeight,
            blockHash:       block.hash,
            totalTx:         txs.length,
            trees,
            nodes,
            edges,
            depth,
            multiParentCount,
            isolatedCount,
            nonTrivialTrees,
            sizeDist,
            stats: {
                treeCount:         roots.length,
                isolatedCount,
                nonTrivialCount:   nonTrivialTrees.length,
                multiParentCount,
                edgeCount:         edges.length,
                largestTreeSize:   trees[0]?.size     || 0,
                largestTreeDepth:  trees[0]?.maxDepth || 0,
            }
        }
    };

    // ============ HTML 报告 ============
    if (config.html) {
        const topN    = config.top   != null ? Number(config.top)   : 5;
        const nodeLimit = config.limit != null ? Number(config.limit) : 300;
        const htmlPath  = generateHTMLReport(result, topN, nodeLimit, config.outputDir || './reports');
        reporter.log(`\n📄 HTML 报告已保存: ${htmlPath}`);
        result.htmlPath = htmlPath;
    }

    return result;
}

// ============ HTML 报告生成 ============

function generateHTMLReport(result, topN, nodeLimit, outputDir) {
    const { blockHeight, blockHash, totalTx, trees, nodes, edges, depth, stats, sizeDist, nonTrivialTrees } = result.data;

    // 选取前 topN 棵非平凡树进行可视化
    const treesToViz = nonTrivialTrees.slice(0, topN);

    // 为每棵树生成 vis.js 数据
    const networkSections = treesToViz.map((tree, idx) => {
        return buildNetworkSection(tree, nodes, depth, idx, nodeLimit);
    });

    // 树大小分布图数据
    const distLabels = JSON.stringify(sizeDist.map(d => d.label));
    const distValues = JSON.stringify(sizeDist.map(d => d.value));

    // 统计表格行
    const topTreeRows = nonTrivialTrees.slice(0, 20).map((tree, i) => {
        const root   = tree.root;
        const short  = root.slice(0, 16) + '...';
        const isViz  = i < topN;
        return `<tr class="${isViz ? 'viz-row' : ''}">
            <td>${i + 1}</td>
            <td><code title="${root}">${short}</code></td>
            <td>${tree.size}</td>
            <td>${tree.maxDepth}</td>
            <td>${isViz ? '<span class="badge">已可视化</span>' : ''}</td>
        </tr>`;
    }).join('\n');

    const networkHTMLSections = networkSections.map(s => s.html).join('\n');
    const networkJSSections   = networkSections.map(s => s.js).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>区块 #${blockHeight} 交易森林分析</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/vis-network@9/dist/vis-network.min.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/vis-network@9/dist/dist/vis-network.min.css">
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0; padding: 20px;
            background: #f0f2f5; color: #333;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: white; padding: 28px 32px;
            border-radius: 14px; margin-bottom: 24px;
        }
        .header h1 { margin: 0 0 8px; font-size: 24px; }
        .header p  { margin: 0; opacity: 0.9; font-size: 14px; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 14px; margin-bottom: 24px;
        }
        .stat-card {
            background: white; padding: 18px 20px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }
        .stat-card .val { font-size: 28px; font-weight: 700; color: #11998e; }
        .stat-card .lbl { font-size: 13px; color: #888; margin-top: 4px; }
        .section {
            background: white; padding: 22px 24px;
            border-radius: 12px; margin-bottom: 22px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }
        .section h2 { margin: 0 0 16px; font-size: 17px; color: #444; }
        .network-container {
            width: 100%; height: 480px;
            border: 1px solid #e8e8e8; border-radius: 8px;
            background: #fafafa;
        }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f0f0f0; }
        th { background: #f7f8fa; font-weight: 600; color: #555; }
        tr:hover { background: #f9f9f9; }
        .viz-row { background: #f0fff8; }
        .badge {
            background: #11998e; color: white;
            padding: 2px 8px; border-radius: 10px; font-size: 12px;
        }
        code { font-family: 'SF Mono', Consolas, monospace; font-size: 13px; color: #2c7a7b; }
        .tree-label {
            font-size: 13px; color: #666; margin-bottom: 8px;
            padding: 8px 12px; background: #f7f8fa; border-radius: 6px;
        }
        .legend { display: flex; gap: 20px; margin-bottom: 10px; flex-wrap: wrap; }
        .legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
        .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
    </style>
</head>
<body>
<div class="container">

    <div class="header">
        <h1>🌲 区块 #${blockHeight} 交易森林分析</h1>
        <p>区块哈希: ${blockHash} &nbsp;|&nbsp; 生成时间: ${new Date().toLocaleString('zh-CN')}</p>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-grid">
        <div class="stat-card"><div class="val">${totalTx}</div><div class="lbl">总交易数</div></div>
        <div class="stat-card"><div class="val">${stats.treeCount}</div><div class="lbl">树（根节点）数量</div></div>
        <div class="stat-card"><div class="val">${stats.nonTrivialCount}</div><div class="lbl">非平凡树</div></div>
        <div class="stat-card"><div class="val">${stats.isolatedCount}</div><div class="lbl">独立交易</div></div>
        <div class="stat-card"><div class="val">${stats.edgeCount}</div><div class="lbl">区块内依赖边数</div></div>
        <div class="stat-card"><div class="val">${stats.multiParentCount}</div><div class="lbl">多父节点交易</div></div>
        <div class="stat-card"><div class="val">${stats.largestTreeSize}</div><div class="lbl">最大树节点数</div></div>
        <div class="stat-card"><div class="val">${stats.largestTreeDepth}</div><div class="lbl">最大树深度</div></div>
    </div>

    <!-- 树大小分布 -->
    ${sizeDist.length > 0 ? `
    <div class="section">
        <h2>非平凡树大小分布</h2>
        <div style="max-height:220px">
            <canvas id="distChart"></canvas>
        </div>
    </div>` : ''}

    <!-- 前N棵树统计表 -->
    <div class="section">
        <h2>最大树列表（前 ${Math.min(20, nonTrivialTrees.length)} 棵非平凡树）</h2>
        <table>
            <thead><tr><th>#</th><th>根交易ID</th><th>节点数</th><th>最大深度</th><th>状态</th></tr></thead>
            <tbody>
                ${topTreeRows}
            </tbody>
        </table>
    </div>

    <!-- 网络图可视化 -->
    ${networkHTMLSections}

</div>
<script>
// ===== 树大小分布柱状图 =====
${sizeDist.length > 0 ? `
(function() {
    const ctx = document.getElementById('distChart');
    if (!ctx) return;
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ${distLabels},
            datasets: [{
                label: '树数量',
                data: ${distValues},
                backgroundColor: 'rgba(17, 153, 142, 0.7)',
                borderColor: 'rgba(17, 153, 142, 1)',
                borderWidth: 1,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: '树节点数范围' } },
                y: { title: { display: true, text: '树数量' }, beginAtZero: true }
            }
        }
    });
})();` : ''}

// ===== 网络图 =====
${networkJSSections}
</script>
</body>
</html>`;

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const filename = `tx-forest_${blockHeight}_${Date.now()}.html`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, html, 'utf8');
    return filepath;
}

/**
 * 为单棵树生成 vis.js HTML + JS 片段
 */
function buildNetworkSection(tree, allNodes, depth, idx, nodeLimit) {
    const divId = `network_${idx}`;
    const isLimited = tree.nodes.size > nodeLimit;

    // 若超出节点限制，做 BFS 剪裁（保留最浅的 nodeLimit 个节点）
    let visibleTxids;
    if (isLimited) {
        // BFS 按深度优先选取
        const sorted = Array.from(tree.nodes).sort((a, b) => (depth.get(a) || 0) - (depth.get(b) || 0));
        visibleTxids = new Set(sorted.slice(0, nodeLimit));
    } else {
        visibleTxids = tree.nodes;
    }

    const visNodes = [];
    const visEdges = [];
    const edgeSeen = new Set();

    for (const txid of visibleTxids) {
        const node   = allNodes.get(txid);
        const d      = depth.get(txid) || 0;
        const isRoot = node.parents.size === 0;
        const isMultiParent = node.parents.size > 1;
        const short  = txid.slice(0, 8);

        // 节点颜色：根节点绿色，多父节点橙色，普通节点蓝色
        let color;
        if (isRoot)        color = { background: '#27ae60', border: '#1e8449', highlight: { background: '#2ecc71', border: '#27ae60' } };
        else if (isMultiParent) color = { background: '#e67e22', border: '#ca6f1e', highlight: { background: '#f39c12', border: '#e67e22' } };
        else               color = { background: '#3498db', border: '#2980b9', highlight: { background: '#5dade2', border: '#3498db' } };

        visNodes.push({
            id:    txid,
            label: short,
            title: `txid: ${txid}\\n深度: ${d}\\n父节点数: ${node.parents.size}\\n子节点数: ${node.children.size}`,
            color,
            level: d,
            font:  { color: '#fff', size: 11 },
            shape: isRoot ? 'diamond' : (isMultiParent ? 'square' : 'dot'),
            size:  isRoot ? 14 : (isMultiParent ? 10 : 8),
        });

        // 添加从父到子的有向边（只在可见节点内）
        for (const parentTxid of node.parents) {
            if (visibleTxids.has(parentTxid)) {
                const edgeKey = `${parentTxid}→${txid}`;
                if (!edgeSeen.has(edgeKey)) {
                    edgeSeen.add(edgeKey);
                    visEdges.push({
                        from:   parentTxid,
                        to:     txid,
                        arrows: 'to',
                        color:  { color: '#aaa', highlight: '#555' },
                        width:  1,
                    });
                }
            }
        }
    }

    const rootShort   = tree.root.slice(0, 16) + '...';
    const limitNotice = isLimited ? `（节点数超过 ${nodeLimit}，仅展示前 ${nodeLimit} 个）` : '';

    const html = `
    <div class="section">
        <h2>树 #${idx + 1} 网络图</h2>
        <div class="legend">
            <div class="legend-item"><div class="legend-dot" style="background:#27ae60"></div>根节点（无区块内父交易，菱形）</div>
            <div class="legend-item"><div class="legend-dot" style="background:#3498db"></div>普通子节点（圆形）</div>
            <div class="legend-item"><div class="legend-dot" style="background:#e67e22"></div>多父节点（方形）</div>
        </div>
        <div class="tree-label">
            根交易: <code>${rootShort}</code> &nbsp;|&nbsp;
            节点数: <strong>${tree.size}</strong> &nbsp;|&nbsp;
            最大深度: <strong>${tree.maxDepth}</strong>
            ${limitNotice}
        </div>
        <div id="${divId}" class="network-container"></div>
    </div>`;

    const nodesJson = JSON.stringify(visNodes);
    const edgesJson = JSON.stringify(visEdges);

    const js = `
(function() {
    const container = document.getElementById('${divId}');
    if (!container) return;
    const nodes = new vis.DataSet(${nodesJson});
    const edges = new vis.DataSet(${edgesJson});
    const network = new vis.Network(container, { nodes, edges }, {
        layout: {
            hierarchical: {
                enabled: true,
                direction: 'UD',
                sortMethod: 'directed',
                levelSeparation: 60,
                nodeSpacing: 50,
            }
        },
        physics: { enabled: false },
        interaction: {
            hover: true,
            navigationButtons: true,
            keyboard: true,
            tooltipDelay: 100,
        },
        nodes: { borderWidth: 1.5 },
        edges: { smooth: { type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.4 } },
    });
})();`;

    return { html, js };
}

// ============ 命令行参数解析 ============
function parseArgs() {
    const args = process.argv.slice(2);
    const config = { rpc: {} };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--block':
            case '-b':
                config.block = parseInt(args[++i]);
                break;
            case '--top':
            case '-t':
                config.top = parseInt(args[++i]);
                break;
            case '--limit':
                config.limit = parseInt(args[++i]);
                break;
            case '--html':
                config.html = true;
                break;
            case '--output-dir':
            case '-o':
                config.outputDir = args[++i];
                break;
            case '--rpc-url':
                config.rpc.url = args[++i];
                break;
            case '--rpc-user':
                config.rpc.username = args[++i];
                break;
            case '--rpc-pass':
                config.rpc.password = args[++i];
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
    console.log(`
用法: node analyzers/tx-forest.js [选项]

选项:
  -b, --block <高度>      目标区块高度（默认: 最新区块）
  -t, --top <N>           HTML 中可视化前 N 棵最大树（默认: 5）
      --limit <N>         每棵树最多展示节点数（默认: 300，防止浏览器卡顿）
      --html              生成 HTML 报告（含 vis.js 网络图）
  -o, --output-dir <目录> 报告输出目录（默认: ./reports）
      --rpc-url <地址>    RPC 地址
      --rpc-user <用户>   RPC 用户名
      --rpc-pass <密码>   RPC 密码
      --silent            静默模式
  -h, --help              显示帮助

示例:
  node analyzers/tx-forest.js --block 824190 --html
  node analyzers/tx-forest.js --block 824190 --html --top 10 --limit 500
  ./framework.js tx-forest --block 824190 --html
`);
}

// ============ 导出和独立运行 ============
module.exports = {
    info:    ANALYZER_INFO,
    analyze: analyzeTxForest
};

if (require.main === module) {
    const config = parseArgs();
    analyzeTxForest(config).catch(err => {
        console.error('错误:', err.message);
        process.exit(1);
    });
}
