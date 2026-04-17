const fs   = require('fs');
const path = require('path');

function generateHtmlReport(db, outputDir = './reports') {
    const rounds = db.getAllRounds();
    const stats  = db.getStats();

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const labels     = JSON.stringify(rounds.map(r => r.height));
    const packedData = JSON.stringify(rounds.map(r => r.packed_from_pool ?? 0));
    const poolBefore = JSON.stringify(rounds.map(r => r.mempool_size_before ?? 0));
    const poolAfter  = JSON.stringify(rounds.map(r => r.mempool_size_after  ?? 0));
    const hData      = JSON.stringify(rounds.map(r => r.mb_h    ?? null));
    const mData      = JSON.stringify(rounds.map(r => r.mb_m    ?? null));
    const genMsData  = JSON.stringify(rounds.map(r => r.mb_gen_ms  ?? null));
    const mineMsData = JSON.stringify(rounds.map(r => r.mb_mine_ms ?? null));

    const mbRounds = rounds.filter(r => r.mb_h != null);
    const hasMb    = mbRounds.length > 0;

    const tableRows = rounds.slice(-50).reverse().map(r => `
        <tr>
            <td>${r.height}</td>
            <td><code>${(r.block_hash || '').slice(0, 16)}…</code></td>
            <td>${r.mempool_size_before ?? '-'}</td>
            <td>${r.mempool_size_after  ?? '-'}</td>
            <td>${r.packed_from_pool    ?? '-'}</td>
            <td>${r.mb_n ?? '-'}</td>
            <td>${r.mb_h ?? '-'}</td>
            <td>${r.mb_m ?? '-'}</td>
            <td>${r.mb_gen_ms  != null ? (r.mb_gen_ms  / 1000).toFixed(1) + 's' : '-'}</td>
            <td>${r.mb_mine_ms != null ? (r.mb_mine_ms / 1000).toFixed(1) + 's' : '-'}</td>
        </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Miner Monitor 汇总报告</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
               margin: 0; padding: 20px; background: #f0f2f5; color: #333; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                  color: white; padding: 28px 32px; border-radius: 14px; margin-bottom: 24px; }
        .header h1 { margin: 0 0 8px; font-size: 24px; }
        .header p  { margin: 0; opacity: 0.8; font-size: 14px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                      gap: 14px; margin-bottom: 24px; }
        .stat-card { background: white; padding: 18px 20px; border-radius: 12px;
                     box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .stat-card .val { font-size: 28px; font-weight: 700; color: #0f3460; }
        .stat-card .lbl { font-size: 13px; color: #888; margin-top: 4px; }
        .section { background: white; padding: 22px 24px; border-radius: 12px;
                   margin-bottom: 22px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .section h2 { margin: 0 0 16px; font-size: 17px; color: #444; }
        .chart-wrap { position: relative; height: 220px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #f0f0f0; }
        th { background: #f7f8fa; font-weight: 600; color: #555; }
        tr:hover { background: #f9f9f9; }
        code { font-family: 'SF Mono', Consolas, monospace; color: #0f3460; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Miner Monitor 汇总报告</h1>
        <p>生成时间: ${new Date().toLocaleString('zh-CN')} &nbsp;|&nbsp; 共 ${rounds.length} 轮</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="val">${stats.totalRounds}</div><div class="lbl">总轮数</div></div>
        <div class="stat-card"><div class="val">${stats.totalPacked.toLocaleString()}</div><div class="lbl">总打包交易数</div></div>
        <div class="stat-card"><div class="val">${stats.avgMempoolBefore.toLocaleString()}</div><div class="lbl">均值内存池大小</div></div>
        <div class="stat-card"><div class="val">${stats.avgPackRate}</div><div class="lbl">均值打包率</div></div>
        <div class="stat-card"><div class="val">${mbRounds.length}</div><div class="lbl">MB增强轮数</div></div>
        <div class="stat-card"><div class="val">${rounds.length - mbRounds.length}</div><div class="lbl">纯ZMQ轮数</div></div>
    </div>

    <div class="section">
        <h2>每轮打包数量 &amp; 内存池大小趋势</h2>
        <div class="chart-wrap"><canvas id="packChart"></canvas></div>
    </div>

    ${hasMb ? `
    <div class="section">
        <h2>miner-bridge 参数分布（h / m）</h2>
        <div class="chart-wrap"><canvas id="hmChart"></canvas></div>
    </div>
    <div class="section">
        <h2>各阶段耗时（生成 / 挖矿）</h2>
        <div class="chart-wrap"><canvas id="timeChart"></canvas></div>
    </div>` : ''}

    <div class="section">
        <h2>原始数据（最近 50 轮）</h2>
        <table>
            <thead><tr>
                <th>高度</th><th>区块哈希</th><th>池前</th><th>池后</th><th>打包</th>
                <th>n</th><th>h</th><th>m</th><th>生成耗时</th><th>挖矿耗时</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
        </table>
    </div>
</div>
<script>
(function() {
    const labels = ${labels};

    new Chart(document.getElementById('packChart'), {
        data: {
            labels,
            datasets: [
                { type: 'line', label: '打包数',   data: ${packedData}, borderColor: '#0f3460', backgroundColor: 'rgba(15,52,96,0.1)', yAxisID: 'y', tension: 0.3, pointRadius: 2 },
                { type: 'line', label: '池前大小', data: ${poolBefore}, borderColor: '#e94560', backgroundColor: 'rgba(233,69,96,0.05)', yAxisID: 'y', tension: 0.3, pointRadius: 2, borderDash: [4,2] },
                { type: 'line', label: '池后大小', data: ${poolAfter},  borderColor: '#aaa', backgroundColor: 'transparent', yAxisID: 'y', tension: 0.3, pointRadius: 0, borderDash: [2,2] },
            ]
        },
        options: { responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, title: { display: true, text: '交易数' } } },
            plugins: { legend: { position: 'top' } } }
    });

    ${hasMb ? `
    new Chart(document.getElementById('hmChart'), {
        data: {
            labels,
            datasets: [
                { type: 'line', label: '实际最大深度 h', data: ${hData}, borderColor: '#e94560', tension: 0.3, pointRadius: 2 },
                { type: 'line', label: '截取点 m',       data: ${mData}, borderColor: '#f5a623', tension: 0.3, pointRadius: 2 },
            ]
        },
        options: { responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, title: { display: true, text: '深度' } } },
            plugins: { legend: { position: 'top' } } }
    });

    new Chart(document.getElementById('timeChart'), {
        data: {
            labels,
            datasets: [
                { type: 'bar', label: '生成耗时(s)', data: ${genMsData}.map(v => v != null ? v/1000 : null),  backgroundColor: 'rgba(15,52,96,0.6)',  yAxisID: 'y' },
                { type: 'bar', label: '挖矿耗时(s)', data: ${mineMsData}.map(v => v != null ? v/1000 : null), backgroundColor: 'rgba(233,69,96,0.6)', yAxisID: 'y' },
            ]
        },
        options: { responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, title: { display: true, text: '秒' } } },
            plugins: { legend: { position: 'top' } } }
    });
    ` : ''}
})();
</script>
</body>
</html>`;

    const filename = `miner-monitor-${Date.now()}.html`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, html, 'utf8');
    return filepath;
}

module.exports = { generateHtmlReport };
