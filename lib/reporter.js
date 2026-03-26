/**
 * 统一报告输出模块
 * 支持控制台文本输出和 HTML 报告生成
 */

const fs = require('fs');
const path = require('path');

class Reporter {
    constructor(options = {}) {
        this.outputDir = options.outputDir || './reports';
        this.silent = options.silent || false;
    }

    /**
     * 打印标题
     */
    title(text) {
        if (this.silent) return;
        console.log('\n' + '='.repeat(60));
        console.log(text);
        console.log('='.repeat(60));
    }

    /**
     * 打印章节标题
     */
    section(text) {
        if (this.silent) return;
        console.log('\n--- ' + text + ' ---');
    }

    /**
     * 打印键值对
     */
    kv(key, value) {
        if (this.silent) return;
        const keyStr = key.toString().padEnd(20);
        const valueStr = typeof value === 'number' ? value.toLocaleString() : value;
        console.log(`  ${keyStr}: ${valueStr}`);
    }

    /**
     * 打印统计对象
     */
    stats(statsObj, indent = 2) {
        if (this.silent) return;
        const prefix = ' '.repeat(indent);
        for (const [key, value] of Object.entries(statsObj)) {
            if (typeof value === 'object' && value !== null) {
                console.log(`${prefix}${key}:`);
                this.stats(value, indent + 2);
            } else {
                const valueStr = typeof value === 'number'
                    ? (Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4))
                    : value;
                console.log(`${prefix}${key.padEnd(15)}: ${valueStr}`);
            }
        }
    }

    /**
     * 打印表格
     */
    table(headers, rows) {
        if (this.silent) return;

        // 计算列宽
        const colWidths = headers.map((h, i) => {
            const headerLen = h.toString().length;
            const maxDataLen = Math.max(...rows.map(r =>
                (r[i] ?? '').toString().length
            ));
            return Math.max(headerLen, maxDataLen) + 2;
        });

        // 打印分隔线
        const line = '+' + colWidths.map(w => '-'.repeat(w + 1)).join('+') + '+';

        // 打印表头
        console.log(line);
        console.log('| ' + headers.map((h, i) => h.toString().padEnd(colWidths[i])).join(' | ') + ' |');
        console.log(line);

        // 打印数据行
        for (const row of rows) {
            console.log('| ' + row.map((cell, i) => {
                const str = (cell ?? '').toString();
                return str.padEnd(colWidths[i]);
            }).join(' | ') + ' |');
        }
        console.log(line);
    }

    /**
     * 绘制简单 ASCII 折线图
     */
    lineChart(data, labels, options = {}) {
        if (this.silent) return;

        const width = options.width || 60;
        const height = options.height || 12;
        const title = options.title || '';

        const maxVal = Math.max(...data);
        const minVal = Math.min(...data);
        const range = maxVal - minVal || 1;

        // 创建画布
        const canvas = Array(height).fill(null).map(() => Array(width).fill(' '));

        // 绘制坐标轴
        for (let y = 0; y < height - 1; y++) {
            canvas[y][0] = '│';
        }
        for (let x = 0; x < width; x++) {
            canvas[height - 1][x] = '─';
        }
        canvas[height - 1][0] = '└';

        // 绘制数据点
        for (let i = 0; i < data.length; i++) {
            const x = Math.floor((i / (data.length - 1 || 1)) * (width - 8)) + 4;
            const y = height - 2 - Math.floor(((data[i] - minVal) / range) * (height - 3));

            if (x >= 0 && x < width && y >= 0 && y < height - 1) {
                canvas[y][x] = '·';
            }
        }

        // 输出
        if (title) console.log(`\n  ${title}`);
        console.log(`  max: ${maxVal.toFixed(2)}`);
        for (const row of canvas) {
            console.log('  ' + row.join(''));
        }
        console.log(`  min: ${minVal.toFixed(2)}`);
    }

    /**
     * 绘制 ASCII 柱状图
     */
    barChart(data, options = {}) {
        if (this.silent) return;

        const width = options.width || 40;
        const title = options.title || '';

        const maxVal = Math.max(...data.map(d => d.count || d.value || 0));

        if (title) console.log(`\n  ${title}`);

        for (const item of data) {
            const label = (item.label || item.name || '').toString().padStart(12);
            const value = item.count || item.value || 0;
            const barLen = maxVal > 0 ? Math.round((value / maxVal) * width) : 0;
            const bar = '█'.repeat(barLen);
            const percent = ((value / (data.reduce((a, b) => a + (b.count || b.value || 0), 0) || 1)) * 100).toFixed(1);

            console.log(`  ${label} │${bar.padEnd(width)} ${value.toString().padStart(6)} (${percent}%)`);
        }
    }

    /**
     * 生成 HTML 报告
     */
    generateHTML(results, options = {}) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = options.filename || `report_${timestamp}.html`;

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        const filepath = path.join(this.outputDir, filename);

        const html = this.buildHTML(results, options);
        fs.writeFileSync(filepath, html);

        return filepath;
    }

    /**
     * 构建 HTML 内容
     */
    buildHTML(results, options = {}) {
        const title = options.title || '链分析报告';

        const sections = results.map((result, index) => {
            if (!result.data) return '';
            return this.buildResultSection(result, index);
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f7fa;
            color: #333;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header h1 { margin: 0 0 10px 0; font-size: 32px; }
        .header p { margin: 0; opacity: 0.9; }
        .analyzer-section {
            background: white;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        .analyzer-header {
            display: flex;
            align-items: center;
            margin-bottom: 25px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
        }
        .analyzer-icon {
            font-size: 32px;
            margin-right: 15px;
        }
        .analyzer-title {
            flex: 1;
        }
        .analyzer-title h2 {
            margin: 0 0 5px 0;
            font-size: 24px;
            color: #333;
        }
        .analyzer-title p {
            margin: 0;
            color: #666;
            font-size: 14px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }
        .stat-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-label {
            color: #666;
            font-size: 13px;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stat-value {
            font-size: 26px;
            font-weight: bold;
            color: #333;
        }
        .chart-container {
            margin: 25px 0;
            padding: 20px;
            background: #fafafa;
            border-radius: 10px;
        }
        .chart-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 15px;
            color: #555;
        }
        .timestamp {
            text-align: center;
            color: #999;
            font-size: 13px;
            margin-top: 40px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔗 ${title}</h1>
            <p>生成时间: ${new Date().toLocaleString('zh-CN')}</p>
        </div>

        ${sections}

        <div class="timestamp">
            由 Chain Analyzer 框架生成
        </div>
    </div>

    <script>
        ${results.map((r, i) => this.buildChartScripts(r, i)).join('\n')}
    </script>
</body>
</html>`;
    }

    buildResultSection(result, index) {
        const info = result.info || {};
        const data = result.data || {};

        let statsHtml = '';
        if (data.stats) {
            const stats = data.stats;
            statsHtml = `
        <div class="stats-grid">
            ${Object.entries(stats).map(([key, value]) => {
                if (typeof value === 'object') return '';
                const displayValue = typeof value === 'number'
                    ? (Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2))
                    : value;
                return `
            <div class="stat-card">
                <div class="stat-label">${this.translateKey(key)}</div>
                <div class="stat-value">${displayValue}</div>
            </div>`;
            }).join('')}
        </div>`;
        }

        let chartsHtml = '';
        if (data.charts) {
            chartsHtml = data.charts.map((chart, ci) => `
        <div class="chart-container">
            <div class="chart-title">${chart.title}</div>
            <canvas id="chart_${index}_${ci}" height="${chart.height || 80}"></canvas>
        </div>
            `).join('');
        }

        return `
    <div class="analyzer-section">
        <div class="analyzer-header">
            <div class="analyzer-icon">${info.icon || '📊'}</div>
            <div class="analyzer-title">
                <h2>${info.name || '未命名分析'}</h2>
                <p>${info.description || ''}</p>
            </div>
        </div>

        ${statsHtml}
        ${chartsHtml}
    </div>`;
    }

    buildChartScripts(result, index) {
        if (!result.data || !result.data.charts) return '';

        return result.data.charts.map((chart, ci) => {
            const ctx = `document.getElementById('chart_${index}_${ci}').getContext('2d')`;

            const datasets = chart.datasets || [{
                label: chart.label || '数据',
                data: chart.data,
                borderColor: chart.color || 'rgb(102, 126, 234)',
                backgroundColor: chart.backgroundColor || 'rgba(102, 126, 234, 0.1)'
            }];

            return `
new Chart(${ctx}, {
    type: '${chart.type || 'line'}',
    data: {
        labels: ${JSON.stringify(chart.labels || [])},
        datasets: ${JSON.stringify(datasets)}
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: ${datasets.length > 1} }
        },
        scales: {
            x: {
                display: true,
                title: { display: !!chart.xLabel, text: '${chart.xLabel || ''}' }
            },
            y: {
                display: true,
                beginAtZero: true,
                title: { display: !!chart.yLabel, text: '${chart.yLabel || ''}' }
            }
        }
    }
});`;
        }).join('\n');
    }

    translateKey(key) {
        const translations = {
            count: '样本数',
            mean: '平均值',
            median: '中位数',
            min: '最小值',
            max: '最大值',
            stdDev: '标准差',
            cv: '变异系数',
            p90: 'P90',
            p95: 'P95',
            p99: 'P99',
            total: '总数',
            avg: '平均值',
            sum: '总和'
        };
        return translations[key] || key;
    }

    /**
     * 打印日志
     */
    log(...args) {
        if (!this.silent) {
            console.log(...args);
        }
    }

    /**
     * 打印错误
     */
    error(...args) {
        console.error(...args);
    }
}

module.exports = { Reporter };
