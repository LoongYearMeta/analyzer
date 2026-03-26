#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ========================
// RPC 配置
// ========================
const RPC = {
    url: process.env.RPC_URL || 'http://localhost:8332',
    auth: {
        username: process.env.RPC_USER || 'username',
        password: process.env.RPC_PASS || 'randompasswd'
    }
};

// 缓存
const txCache = new Map();
const blockCache = new Map();
const MAX_DEPTH_LIMIT = 1000;

// ========================
// RPC 调用
// ========================
async function rpc(method, params = [], timeout = 30000) {
    try {
        const res = await axios.post(RPC.url, {
            jsonrpc: '1.0',
            id: 'analyze',
            method,
            params
        }, {
            auth: RPC.auth,
            timeout
        });

        if (res.data.error) throw res.data.error;
        return res.data.result;
    } catch (err) {
        console.error(`RPC错误 [${method}]:`, err.message);
        throw err;
    }
}

async function getBlockCount() {
    return await rpc('getblockcount');
}

async function getBlockByHeight(height, verbosity = 1) {
    const cacheKey = `${height}_${verbosity}`;
    if (blockCache.has(cacheKey)) {
        return blockCache.get(cacheKey);
    }

    const hash = await rpc('getblockhash', [height]);
    const block = await rpc('getblock', [hash, verbosity]);
    blockCache.set(cacheKey, block);
    return block;
}

async function getRawTransaction(txid, blockHash = null) {
    if (txCache.has(txid)) {
        return txCache.get(txid);
    }

    try {
        const params = blockHash ? [txid, true, blockHash] : [txid, true];
        const tx = await rpc('getrawtransaction', params);
        txCache.set(txid, tx);
        return tx;
    } catch (err) {
        return null;
    }
}

// ========================
// 统计工具函数
// ========================
function calculateMode(arr) {
    const frequency = {};
    let maxCount = 0;
    let modes = [];

    for (const num of arr) {
        frequency[num] = (frequency[num] || 0) + 1;
        if (frequency[num] > maxCount) {
            maxCount = frequency[num];
        }
    }

    for (const [num, count] of Object.entries(frequency)) {
        if (count === maxCount) {
            modes.push(parseInt(num));
        }
    }

    return { modes, count: maxCount };
}

function calculateMedian(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function calculatePercentile(arr, percentile) {
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

// ========================
// 区块交易数量分析
// ========================
async function analyzeBlockTxCounts(startHeight, endHeight) {
    console.log('\n=== 区块交易数量分析 ===');
    console.log(`分析区块范围: ${startHeight} - ${endHeight}`);
    console.log(`分析区块数: ${endHeight - startHeight + 1}`);
    console.log('');

    const txCounts = [];
    const blockData = [];
    let maxTxCount = 0;
    let maxTxBlock = null;

    console.log('正在获取区块数据...');

    const batchSize = 100;
    const totalBlocks = endHeight - startHeight + 1;

    for (let h = startHeight; h <= endHeight; h += batchSize) {
        const batchEnd = Math.min(h + batchSize - 1, endHeight);
        const promises = [];

        for (let height = h; height <= batchEnd; height++) {
            promises.push(
                getBlockByHeight(height, 1)
                    .then(block => {
                        const numTx = block.nTx || (block.tx ? block.tx.length : 0);
                        return { height, numTx, time: block.time };
                    })
                    .catch(err => {
                        console.error(`\n获取区块 ${height} 失败:`, err.message);
                        return { height, numTx: 0, error: true };
                    })
            );
        }

        const results = await Promise.all(promises);

        for (const result of results) {
            if (!result.error) {
                txCounts.push(result.numTx);
                blockData.push(result);

                if (result.numTx > maxTxCount) {
                    maxTxCount = result.numTx;
                    maxTxBlock = result.height;
                }
            }
        }

        const progress = ((batchEnd - startHeight + 1) / totalBlocks * 100).toFixed(1);
        process.stdout.write(`\r进度: ${progress}% (${batchEnd - startHeight + 1}/${totalBlocks})`);
    }

    console.log('\n');

    if (txCounts.length === 0) {
        console.error('未能获取任何区块数据');
        return null;
    }

    // 计算统计数据
    const modeResult = calculateMode(txCounts);
    const median = calculateMedian(txCounts);
    const min = Math.min(...txCounts);
    const max = Math.max(...txCounts);
    const avg = txCounts.reduce((a, b) => a + b, 0) / txCounts.length;
    const p90 = calculatePercentile(txCounts, 90);
    const p95 = calculatePercentile(txCounts, 95);
    const p99 = calculatePercentile(txCounts, 99);

    // 输出结果
    console.log('=== 统计结果 ===');
    console.log(`分析区块数: ${txCounts.length}`);
    console.log('');
    console.log('【交易数量统计】');
    console.log(`  最小值: ${min}`);
    console.log(`  最大值: ${max}`);
    console.log(`  平均值: ${avg.toFixed(2)}`);
    console.log(`  中位数: ${median}`);
    console.log(`  P90: ${p90}`);
    console.log(`  P95: ${p95}`);
    console.log(`  P99: ${p99}`);
    console.log('');
    console.log('【众数】');
    console.log(`  众数值: ${modeResult.modes.join(', ')}`);
    console.log(`  出现次数: ${modeResult.count} 次`);
    console.log(`  占比: ${(modeResult.count / txCounts.length * 100).toFixed(2)}%`);
    console.log('');
    console.log('【交易最多的区块】');
    console.log(`  区块高度: ${maxTxBlock}`);
    console.log(`  交易数量: ${maxTxCount}`);
    console.log('');

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

    console.log('【交易数量分布】');
    for (const range of ranges) {
        const count = txCounts.filter(n => n >= range.min && n <= range.max).length;
        const percentage = (count / txCounts.length * 100).toFixed(2);
        if (count > 0) {
            console.log(`  ${range.label.padStart(10)}: ${count.toString().padStart(5)} 区块 (${percentage}%)`);
        }
    }

    return {
        type: 'txCount',
        startHeight,
        endHeight,
        txCounts,
        blockData,
        stats: { min, max, avg, median, p90, p95, p99, mode: modeResult }
    };
}

// ========================
// 祖先高度分析
// ========================
async function calculateAncestorDepthIterative(tx) {
    if (!tx || !tx.vin || tx.vin.length === 0) return 0;
    if (tx.vin[0].coinbase) return 0;

    let maxDepth = 0;
    const queue = [];

    queue.push({ tx, depth: 0, pathVisited: new Set() });

    while (queue.length > 0) {
        const { tx: currentTx, depth, pathVisited } = queue.shift();

        if (depth > MAX_DEPTH_LIMIT) continue;

        if (!currentTx || !currentTx.vin || currentTx.vin.length === 0) {
            maxDepth = Math.max(maxDepth, depth);
            continue;
        }

        if (currentTx.vin[0].coinbase) {
            maxDepth = Math.max(maxDepth, depth);
            continue;
        }

        let hasUnprocessedInput = false;

        for (const input of currentTx.vin) {
            if (!input.txid) continue;
            if (pathVisited.has(input.txid)) continue;

            const newPathVisited = new Set(pathVisited);
            newPathVisited.add(input.txid);

            try {
                const parentTx = await getRawTransaction(input.txid);
                if (parentTx) {
                    hasUnprocessedInput = true;
                    queue.push({
                        tx: parentTx,
                        depth: depth + 1,
                        pathVisited: newPathVisited
                    });
                }
            } catch (err) {
                // 无法获取父交易，此分支结束
            }
        }

        if (!hasUnprocessedInput) {
            maxDepth = Math.max(maxDepth, depth);
        }
    }

    return maxDepth;
}

async function analyzeBlockAncestorDepth(blockHeight, verbose = false) {
    console.log(`分析区块 ${blockHeight}...`);

    try {
        const block = await getBlockByHeight(blockHeight, 2);

        if (!block.tx || block.tx.length === 0) {
            return { height: blockHeight, maxDepth: 0, depths: [], totalTx: 0, regularTx: 0 };
        }

        const depths = [];
        let maxDepthInBlock = 0;
        let maxDepthTxId = null;

        const regularTxs = block.tx.filter(tx => {
            if (!tx.vin || tx.vin.length === 0) return false;
            return !tx.vin[0].coinbase;
        });

        for (const tx of block.tx) {
            if (tx.txid) {
                txCache.set(tx.txid, tx);
            }
        }

        if (verbose) {
            console.log(`  总交易数: ${block.tx.length}, 普通交易: ${regularTxs.length}`);
        }

        for (let i = 0; i < regularTxs.length; i++) {
            const tx = regularTxs[i];
            process.stdout.write(`\r  分析进度: ${i + 1}/${regularTxs.length}`);

            const depth = await calculateAncestorDepthIterative(tx);
            depths.push({ txid: tx.txid, depth, inputs: tx.vin.length });

            if (depth > maxDepthInBlock) {
                maxDepthInBlock = depth;
                maxDepthTxId = tx.txid;
            }
        }

        console.log(`\r  分析完成: ${regularTxs.length}/${regularTxs.length}`);

        if (depths.length > 0) {
            const depthValues = depths.map(d => d.depth);
            const avgDepth = depthValues.reduce((a, b) => a + b, 0) / depthValues.length;
            const medianDepth = calculateMedian(depthValues);
            const modeResult = calculateMode(depthValues);

            return {
                height: blockHeight,
                maxDepth: maxDepthInBlock,
                maxDepthTxId,
                minDepth: Math.min(...depthValues),
                avgDepth,
                medianDepth,
                modeDepth: modeResult.modes[0],
                modeCount: modeResult.count,
                totalTx: block.tx.length,
                regularTx: regularTxs.length,
                depths,
                time: block.time
            };
        }

        return {
            height: blockHeight,
            maxDepth: 0,
            depths: [],
            totalTx: block.tx.length,
            regularTx: 0,
            time: block.time
        };

    } catch (err) {
        console.error(`\n  分析区块 ${blockHeight} 失败:`, err.message);
        return { height: blockHeight, error: err.message };
    }
}

async function analyzeAncestorDepthRange(startHeight, endHeight) {
    console.log('\n=== 区块交易祖先高度分析 ===');
    console.log(`分析区块范围: ${startHeight} - ${endHeight}`);
    console.log(`预计分析区块数: ${endHeight - startHeight + 1}`);
    console.log('');

    const blockResults = [];

    for (let h = startHeight; h <= endHeight; h++) {
        const result = await analyzeBlockAncestorDepth(h, false);
        if (!result.error) {
            blockResults.push(result);
            console.log(`  区块 ${h}: 最大祖先深度: ${result.maxDepth.toString().padStart(4)}, ` +
                `交易数: ${result.regularTx.toString().padStart(4)}, ` +
                `平均深度: ${result.avgDepth?.toFixed(1) || 'N/A'}`);
        }

        // 每分析10个区块清理一次缓存
        if ((h - startHeight + 1) % 10 === 0) {
            txCache.clear();
            console.log('  [缓存清理]');
        }
    }

    // 输出整体统计
    console.log('\n=== 整体统计 ===');

    if (blockResults.length === 0) {
        console.log('没有有效的分析结果');
        return null;
    }

    const allMaxDepths = blockResults.map(r => r.maxDepth);
    const globalMaxDepth = Math.max(...allMaxDepths);
    const blockWithMaxDepth = blockResults.find(r => r.maxDepth === globalMaxDepth);

    console.log(`分析区块数: ${blockResults.length}`);
    console.log('');
    console.log('【各区块最大祖先深度统计】');
    console.log(`  全局最大值: ${globalMaxDepth} (区块 ${blockWithMaxDepth?.height})`);
    console.log(`  平均值: ${(allMaxDepths.reduce((a, b) => a + b, 0) / allMaxDepths.length).toFixed(2)}`);
    console.log(`  中位数: ${calculateMedian(allMaxDepths)}`);

    const modeResult = calculateMode(allMaxDepths);
    console.log(`  众数值: ${modeResult.modes.join(', ')}`);

    console.log('');
    console.log('【祖先深度分布（按区块最大值）】');
    const ranges = [
        { max: 0, label: '0' },
        { max: 5, label: '1-5' },
        { max: 10, label: '6-10' },
        { max: 20, label: '11-20' },
        { max: 50, label: '21-50' },
        { max: 100, label: '51-100' },
        { max: Infinity, label: '>100' }
    ];

    let prevMax = -1;
    for (const range of ranges) {
        const count = allMaxDepths.filter(d => d > prevMax && d <= range.max).length;
        if (count > 0) {
            const percentage = (count / allMaxDepths.length * 100).toFixed(1);
            console.log(`  ${range.label.padStart(6)}: ${count.toString().padStart(4)} 区块 (${percentage}%)`);
        }
        prevMax = range.max;
    }

    return {
        type: 'ancestorDepth',
        startHeight,
        endHeight,
        blockResults,
        stats: {
            globalMaxDepth,
            avg: allMaxDepths.reduce((a, b) => a + b, 0) / allMaxDepths.length,
            median: calculateMedian(allMaxDepths),
            mode: modeResult
        }
    };
}

// ========================
// ASCII 图表
// ========================
function drawLineChart(data, labels, title, width = 80, height = 20) {
    const chart = Array(height).fill(null).map(() => Array(width).fill(' '));

    const maxVal = Math.max(...data);
    const minVal = Math.min(...data);
    const range = maxVal - minVal || 1;

    // 绘制坐标轴
    for (let y = 0; y < height - 1; y++) {
        chart[y][0] = '│';
    }
    for (let x = 0; x < width; x++) {
        chart[height - 1][x] = '─';
    }
    chart[height - 1][0] = '└';

    // 绘制数据线
    for (let i = 0; i < data.length - 1; i++) {
        const x1 = Math.floor((i / (data.length - 1)) * (width - 10)) + 5;
        const x2 = Math.floor(((i + 1) / (data.length - 1)) * (width - 10)) + 5;
        const y1 = height - 2 - Math.floor(((data[i] - minVal) / range) * (height - 4));
        const y2 = height - 2 - Math.floor(((data[i + 1] - minVal) / range) * (height - 4));

        // 简单的线条绘制
        const slope = (y2 - y1) / (x2 - x1 || 1);
        for (let x = x1; x <= x2 && x < width; x++) {
            const y = Math.round(y1 + slope * (x - x1));
            if (y >= 0 && y < height - 1) {
                chart[y][x] = '·';
            }
        }
    }

    // 添加标签
    const labelY = `max: ${maxVal}`;
    for (let i = 0; i < labelY.length && i < width - 5; i++) {
        chart[0][width - labelY.length - 1 + i] = labelY[i];
    }

    console.log(`\n${title}`);
    console.log('─'.repeat(width));
    for (const row of chart) {
        console.log(row.join(''));
    }
    console.log('─'.repeat(width));
}

function drawHistogram(data, bins, title, width = 60) {
    const maxCount = Math.max(...bins.map(b => b.count));
    const barWidth = Math.max(1, Math.floor(width / bins.length) - 2);

    console.log(`\n${title}`);
    console.log('─'.repeat(width));

    for (const bin of bins) {
        const barLen = maxCount > 0 ? Math.round((bin.count / maxCount) * barWidth) : 0;
        const bar = '█'.repeat(barLen);
        const percentage = ((bin.count / data.length) * 100).toFixed(1);
        console.log(`${bin.label.padStart(10)} │${bar.padEnd(barWidth)} ${bin.count.toString().padStart(4)} (${percentage}%)`);
    }

    console.log('─'.repeat(width));
}

// ========================
// HTML 报告生成
// ========================
function generateTxCountHTML(data) {
    const { startHeight, endHeight, blockData, stats } = data;
    const timestamps = blockData.map(b => b.time * 1000);
    const txCounts = blockData.map(b => b.numTx);
    const heights = blockData.map(b => b.height);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>区块交易数量分析报告 (${startHeight}-${endHeight})</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stat-label { color: #666; font-size: 14px; margin-bottom: 5px; }
        .stat-value { font-size: 28px; font-weight: bold; color: #333; }
        .chart-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .chart-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; color: #333; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 区块交易数量分析报告</h1>
            <p>分析范围: 区块 ${startHeight} - ${endHeight} | 共 ${blockData.length} 个区块</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">最小交易数</div>
                <div class="stat-value">${stats.min}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">最大交易数</div>
                <div class="stat-value">${stats.max}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">平均值</div>
                <div class="stat-value">${stats.avg.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">中位数</div>
                <div class="stat-value">${stats.median}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">P90</div>
                <div class="stat-value">${stats.p90}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">P99</div>
                <div class="stat-value">${stats.p99}</div>
            </div>
        </div>

        <div class="chart-container">
            <div class="chart-title">📈 区块交易数量趋势 (按时间)</div>
            <canvas id="txChart" height="100"></canvas>
        </div>

        <div class="chart-container">
            <div class="chart-title">📊 交易数量分布</div>
            <canvas id="distChart" height="80"></canvas>
        </div>
    </div>

    <script>
        const ctx1 = document.getElementById('txChart').getContext('2d');
        new Chart(ctx1, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(heights.map(h => '#' + h))},
                datasets: [{
                    label: '交易数量',
                    data: ${JSON.stringify(txCounts)},
                    borderColor: 'rgb(102, 126, 234)',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }]
            },
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => '区块 ' + items[0].label,
                            label: (item) => '交易数: ' + item.raw.toLocaleString()
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: '区块高度' },
                        ticks: { maxTicksLimit: 20 }
                    },
                    y: {
                        title: { display: true, text: '交易数量' },
                        beginAtZero: true
                    }
                }
            }
        });

        const ranges = [
            { min: 0, max: 100, label: '0-100' },
            { min: 101, max: 500, label: '101-500' },
            { min: 501, max: 1000, label: '501-1000' },
            { min: 1001, max: 2000, label: '1001-2000' },
            { min: 2001, max: 5000, label: '2001-5000' },
            { min: 5001, max: 10000, label: '5001-10000' },
            { min: 10001, max: Infinity, label: '>10000' }
        ];
        const distData = ranges.map(r => ({
            label: r.label,
            count: ${JSON.stringify(txCounts)}.filter(n => n >= r.min && n <= r.max).length
        })).filter(d => d.count > 0);

        const ctx2 = document.getElementById('distChart').getContext('2d');
        new Chart(ctx2, {
            type: 'bar',
            data: {
                labels: distData.map(d => d.label),
                datasets: [{
                    label: '区块数量',
                    data: distData.map(d => d.count),
                    backgroundColor: 'rgba(118, 75, 162, 0.7)',
                    borderColor: 'rgb(118, 75, 162)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { title: { display: true, text: '交易数量范围' } },
                    y: { title: { display: true, text: '区块数量' }, beginAtZero: true }
                }
            }
        });
    </script>
</body>
</html>`;

    return html;
}

function generateAncestorDepthHTML(data) {
    const { startHeight, endHeight, blockResults, stats } = data;
    const heights = blockResults.map(b => b.height);
    const maxDepths = blockResults.map(b => b.maxDepth);
    const avgDepths = blockResults.map(b => b.avgDepth || 0);
    const timestamps = blockResults.map(b => b.time * 1000);

    // 计算深度分布
    const allDepths = blockResults.flatMap(b => b.depths?.map(d => d.depth) || []);
    const depthDist = {};
    for (const d of allDepths) {
        depthDist[d] = (depthDist[d] || 0) + 1;
    }
    const sortedDepths = Object.entries(depthDist).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>祖先深度分析报告 (${startHeight}-${endHeight})</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stat-label { color: #666; font-size: 14px; margin-bottom: 5px; }
        .stat-value { font-size: 28px; font-weight: bold; color: #333; }
        .chart-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .chart-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; color: #333; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🌳 祖先深度分析报告</h1>
            <p>分析范围: 区块 ${startHeight} - ${endHeight} | 共 ${blockResults.length} 个区块</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">全局最大深度</div>
                <div class="stat-value">${stats.globalMaxDepth}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">平均最大深度</div>
                <div class="stat-value">${stats.avg.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">中位数</div>
                <div class="stat-value">${stats.median}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">总交易数</div>
                <div class="stat-value">${allDepths.length.toLocaleString()}</div>
            </div>
        </div>

        <div class="chart-container">
            <div class="chart-title">📈 各区块最大祖先深度趋势</div>
            <canvas id="maxDepthChart" height="100"></canvas>
        </div>

        <div class="chart-container">
            <div class="chart-title">📊 各区块平均祖先深度趋势</div>
            <canvas id="avgDepthChart" height="100"></canvas>
        </div>

        <div class="chart-container">
            <div class="chart-title">🍰 祖先深度分布</div>
            <canvas id="depthDistChart" height="80"></canvas>
        </div>
    </div>

    <script>
        const ctx1 = document.getElementById('maxDepthChart').getContext('2d');
        new Chart(ctx1, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(heights.map(h => '#' + h))},
                datasets: [{
                    label: '最大深度',
                    data: ${JSON.stringify(maxDepths)},
                    borderColor: 'rgb(17, 153, 142)',
                    backgroundColor: 'rgba(17, 153, 142, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { title: { display: true, text: '区块高度' }, ticks: { maxTicksLimit: 20 } },
                    y: { title: { display: true, text: '最大深度' }, beginAtZero: true }
                }
            }
        });

        const ctx2 = document.getElementById('avgDepthChart').getContext('2d');
        new Chart(ctx2, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(heights.map(h => '#' + h))},
                datasets: [{
                    label: '平均深度',
                    data: ${JSON.stringify(avgDepths)},
                    borderColor: 'rgb(56, 239, 125)',
                    backgroundColor: 'rgba(56, 239, 125, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { title: { display: true, text: '区块高度' }, ticks: { maxTicksLimit: 20 } },
                    y: { title: { display: true, text: '平均深度' }, beginAtZero: true }
                }
            }
        });

        const ctx3 = document.getElementById('depthDistChart').getContext('2d');
        const depthLabels = ${JSON.stringify(sortedDepths.map(d => d[0]))};
        const depthValues = ${JSON.stringify(sortedDepths.map(d => d[1]))};
        new Chart(ctx3, {
            type: 'bar',
            data: {
                labels: depthLabels.map(d => '深度 ' + d),
                datasets: [{
                    label: '交易数量',
                    data: depthValues,
                    backgroundColor: 'rgba(17, 153, 142, 0.7)',
                    borderColor: 'rgb(17, 153, 142)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { title: { display: true, text: '祖先深度' } },
                    y: { title: { display: true, text: '交易数量' }, beginAtZero: true }
                }
            }
        });
    </script>
</body>
</html>`;

    return html;
}

function saveHTMLReport(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = data.type === 'txCount'
        ? `txcount_report_${data.startHeight}_${data.endHeight}_${timestamp}.html`
        : `ancestor_report_${data.startHeight}_${data.endHeight}_${timestamp}.html`;

    const html = data.type === 'txCount'
        ? generateTxCountHTML(data)
        : generateAncestorDepthHTML(data);

    fs.writeFileSync(filename, html);
    console.log(`\n📄 HTML 报告已保存: ${path.resolve(filename)}`);
    return filename;
}

// ========================
// 主逻辑
// ========================
function printUsage() {
    console.log('用法:');
    console.log('  node chain-analyze.js <命令> [选项] [参数]');
    console.log('');
    console.log('命令:');
    console.log('  blocks    分析区块交易数量');
    console.log('  depth     分析交易祖先深度');
    console.log('');
    console.log('选项:');
    console.log('  --start <高度>   起始区块高度 (默认: 824190 或最新-1000)');
    console.log('  --end <高度>     结束区块高度 (默认: 最新)');
    console.log('  --html           生成 HTML 报告');
    console.log('  --chart          显示 ASCII 图表');
    console.log('');
    console.log('示例:');
    console.log('  node chain-analyze.js blocks --start 824190 --end 824200 --html');
    console.log('  node chain-analyze.js depth --start 824190 --end 824195 --chart');
    console.log('  node chain-analyze.js blocks --html     # 分析最近1000个区块');
    console.log('');
    console.log('环境变量:');
    console.log('  RPC_URL  - RPC地址 (默认: http://localhost:8332)');
    console.log('  RPC_USER - RPC用户名');
    console.log('  RPC_PASS - RPC密码');
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        printUsage();
        return;
    }

    const command = args[0];
    const useHtml = args.includes('--html');
    const useChart = args.includes('--chart');

    let startHeight = null;
    let endHeight = null;

    const startIdx = args.indexOf('--start');
    if (startIdx !== -1 && args[startIdx + 1]) {
        startHeight = parseInt(args[startIdx + 1]);
    }

    const endIdx = args.indexOf('--end');
    if (endIdx !== -1 && args[endIdx + 1]) {
        endHeight = parseInt(args[endIdx + 1]);
    }

    console.log('=== 链分析工具 ===');
    console.log(`RPC: ${RPC.url}`);

    const latestHeight = await getBlockCount();

    // 设置默认值
    if (!startHeight) {
        startHeight = Math.max(1, latestHeight - 999);
    }
    if (!endHeight) {
        endHeight = latestHeight;
    }

    let result = null;

    if (command === 'blocks') {
        result = await analyzeBlockTxCounts(startHeight, endHeight);

        if (result && useChart) {
            const sampleData = result.blockData.filter((_, i) => i % Math.ceil(result.blockData.length / 50) === 0);
            drawLineChart(
                sampleData.map(b => b.numTx),
                sampleData.map(b => b.height),
                '区块交易数量趋势'
            );

            const ranges = [
                { min: 0, max: 100, label: '0-100' },
                { min: 101, max: 500, label: '101-500' },
                { min: 501, max: 1000, label: '501-1000' },
                { min: 1001, max: 2000, label: '1001-2000' },
                { min: 2001, max: 5000, label: '2001-5000' },
                { min: 5001, max: 10000, label: '5001-10000' },
                { min: 10001, max: Infinity, label: '>10000' }
            ];
            const bins = ranges.map(r => ({
                label: r.label,
                count: result.txCounts.filter(n => n >= r.min && n <= r.max).length
            })).filter(b => b.count > 0);

            drawHistogram(result.txCounts, bins, '交易数量分布');
        }

    } else if (command === 'depth') {
        result = await analyzeAncestorDepthRange(startHeight, endHeight);

        if (result && useChart) {
            drawLineChart(
                result.blockResults.map(b => b.maxDepth),
                result.blockResults.map(b => b.height),
                '各区块最大祖先深度'
            );
        }

    } else {
        console.error(`未知命令: ${command}`);
        printUsage();
        process.exit(1);
    }

    if (result && useHtml) {
        const htmlPath = saveHTMLReport(result);
        console.log(`\n🌐 在浏览器中打开查看详细图表: file://${htmlPath}`);
    }
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
