/**
 * 通用绘图模块
 */

const fs = require('fs');
const path = require('path');

// ==================== ASCII 图表 ====================

class ASCIIChart {
  constructor(width = 80, height = 15) {
    this.width = width;
    this.height = height;
    this.canvas = null;
  }

  initCanvas() {
    this.canvas = Array(this.height).fill(null).map(() => Array(this.width).fill(' '));
  }

  drawAxes(options = {}) {
    for (let y = 0; y < this.height - 1; y++) {
      this.canvas[y][0] = '│';
    }
    for (let x = 0; x < this.width; x++) {
      this.canvas[this.height - 1][x] = '─';
    }
    this.canvas[this.height - 1][0] = '└';

    if (options.xLabels) {
      const positions = options.xPositions || this.calculatePositions(options.xLabels.length);
      options.xLabels.forEach((label, i) => {
        const x = positions[i];
        const start = Math.max(0, Math.min(x - Math.floor(label.length / 2), this.width - label.length));
        for (let j = 0; j < label.length && start + j < this.width; j++) {
          this.canvas[this.height - 1][start + j] = label[j];
        }
      });
    }
  }

  calculatePositions(count, isY = false) {
    const maxPos = isY ? this.height - 2 : this.width - 1;
    const positions = [];
    for (let i = 0; i < count; i++) {
      positions.push(Math.round((i / (count - 1 || 1)) * maxPos));
    }
    return positions;
  }

  mapToCanvas(value, min, max, isY = false) {
    const range = max - min || 1;
    if (isY) {
      const normalized = (value - min) / range;
      return Math.max(0, Math.min(this.height - 2, Math.round((1 - normalized) * (this.height - 2))));
    } else {
      const normalized = (value - min) / range;
      return Math.max(0, Math.min(this.width - 1, Math.round(normalized * (this.width - 1))));
    }
  }

  drawPoint(x, y, char = '█') {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height - 1) {
      this.canvas[y][x] = char;
    }
  }

  drawHorizontalLine(y, char = '─') {
    for (let x = 1; x < this.width; x++) {
      if (this.canvas[y][x] === ' ') {
        this.canvas[y][x] = char;
      }
    }
  }

  render() {
    return this.canvas.map(row => row.join('')).join('\n');
  }

  print(title, subtitle = '') {
    if (title) console.log(`\n${title}`);
    if (subtitle) console.log(subtitle);
    console.log(this.render());
  }
}

class ScatterTimeChart extends ASCIIChart {
  draw(data, options = {}) {
    this.initCanvas();

    const xMin = options.xRange?.min || Math.min(...data.map(d => d.x));
    const xMax = options.xRange?.max || Math.max(...data.map(d => d.x));
    const yMin = options.yRange?.min || 0;
    const yMax = options.yRange?.max || 100;

    if (options.avgLine !== undefined) {
      const avgY = this.mapToCanvas(options.avgLine, yMin, yMax, true);
      this.drawHorizontalLine(avgY, '-');
    }

    for (const point of data) {
      const x = this.mapToCanvas(point.x, xMin, xMax, false);
      const y = this.mapToCanvas(point.y, yMin, yMax, true);
      let char = '█';
      if (options.markers) {
        char = options.markers(point) || '█';
      }
      this.drawPoint(x, y, char);
    }

    const timeLabels = this.generateTimeLabels(xMin, xMax, 5);
    this.drawAxes({ xLabels: timeLabels.labels, xPositions: timeLabels.positions });

    return this;
  }

  generateTimeLabels(min, max, count) {
    const range = max - min;
    const labels = [];
    const positions = [];

    for (let i = 0; i < count; i++) {
      const ratio = i / (count - 1 || 1);
      const timestamp = min + range * ratio;
      const date = new Date(timestamp * 1000);
      const label = `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ` +
        `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      labels.push(label);
      positions.push(Math.round(ratio * (this.width - 1)));
    }

    return { labels, positions };
  }
}

class LineChart extends ASCIIChart {
  draw(data, labels, options = {}) {
    this.initCanvas();

    const yMin = options.yRange?.min || Math.min(...data);
    const yMax = options.yRange?.max || Math.max(...data);

    if (options.avgLine !== undefined) {
      const avgY = this.mapToCanvas(options.avgLine, yMin, yMax, true);
      this.drawHorizontalLine(avgY, '-');
    }

    for (let i = 0; i < data.length - 1; i++) {
      const x1 = Math.round((i / (data.length - 1 || 1)) * (this.width - 10)) + 5;
      const x2 = Math.round(((i + 1) / (data.length - 1 || 1)) * (this.width - 10)) + 5;
      const y1 = this.mapToCanvas(data[i], yMin, yMax, true);
      const y2 = this.mapToCanvas(data[i + 1], yMin, yMax, true);
      this.drawLine(x1, y1, x2, y2, '·');
    }

    for (let i = 0; i < data.length; i++) {
      const x = Math.round((i / (data.length - 1 || 1)) * (this.width - 10)) + 5;
      const y = this.mapToCanvas(data[i], yMin, yMax, true);
      this.drawPoint(x, y, options.pointChar || '●');
    }

    const xLabels = labels ? this.sampleLabels(labels, 5) : null;
    this.drawAxes({ xLabels: xLabels?.labels, xPositions: xLabels?.positions });

    return this;
  }

  drawLine(x1, y1, x2, y2, char) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let x = x1, y = y1;

    while (true) {
      this.drawPoint(x, y, char);
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  sampleLabels(labels, count) {
    const step = Math.ceil(labels.length / count);
    const sampled = [];
    const positions = [];
    for (let i = 0; i < labels.length; i += step) {
      sampled.push(labels[i]);
      positions.push(Math.round((i / (labels.length - 1 || 1)) * (this.width - 10)) + 5);
    }
    return { labels: sampled, positions };
  }
}

class BarChart extends ASCIIChart {
  draw(data, options = {}) {
    const entries = Array.isArray(data)
      ? data.map(d => ({ label: d.label || d.name, value: d.value || d.count }))
      : Object.entries(data).map(([k, v]) => ({ label: k, value: v }));

    const maxValue = Math.max(...entries.map(e => e.value));
    const maxLabelLen = Math.max(...entries.map(e => e.label.toString().length));
    const barWidth = Math.max(1, Math.floor((this.width - maxLabelLen - 5) / entries.length) - 1);

    console.log(`\n${options.title || ''}`);
    console.log('─'.repeat(this.width));

    for (const entry of entries) {
      const label = entry.label.toString().padStart(maxLabelLen);
      const barLen = maxValue > 0 ? Math.round((entry.value / maxValue) * barWidth) : 0;
      const bar = '█'.repeat(barLen);
      const total = entries.reduce((a, b) => a + b.value, 0);
      const percentage = total > 0 ? ((entry.value / total) * 100).toFixed(1) : '0.0';
      console.log(`${label} │${bar.padEnd(barWidth)} ${entry.value.toString().padStart(6)} (${percentage}%)`);
    }

    console.log('─'.repeat(this.width));
  }
}

// ==================== HTML Chart.js 生成器 ====================

class HTMLChartBuilder {
  constructor() {
    this.charts = [];
    this.title = '图表报告';
  }

  setTitle(title) {
    this.title = title;
    return this;
  }

  addScatterTimeChart(data, options = {}) {
    this.charts.push({
      type: 'scatter',
      data,
      options
    });
    return this;
  }

  addLineChart(labels, data, options = {}) {
    this.charts.push({
      type: 'line',
      labels,
      data,
      options
    });
    return this;
  }

  addBarChart(labels, data, options = {}) {
    this.charts.push({
      type: 'bar',
      labels,
      data,
      options
    });
    return this;
  }

  generateHTML() {
    const chartDivs = this.charts.map((chart, i) => {
      if (chart.type === 'scatter') {
        return this.generateScatterDiv(chart, i);
      } else if (chart.type === 'line') {
        return this.generateLineDiv(chart, i);
      } else if (chart.type === 'bar') {
        return this.generateBarDiv(chart, i);
      }
      return '';
    }).join('\n');

    const chartScripts = this.charts.map((chart, i) => {
      if (chart.type === 'scatter') {
        return this.generateScatterScript(chart, i);
      } else if (chart.type === 'line') {
        return this.generateLineScript(chart, i);
      } else if (chart.type === 'bar') {
        return this.generateBarScript(chart, i);
      }
      return '';
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"></script>
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
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 20px;
        }
        .header h1 { margin: 0 0 10px 0; }
        .header p { margin: 0; opacity: 0.9; }
        .chart-container {
            background: white;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            position: relative;
        }
        .chart-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 4px;
            color: #555;
        }
        .zoom-hint { font-size: 11px; color: #aaa; margin: 0 0 10px 0; }
        .reset-btn {
            position: absolute; top: 16px; right: 16px;
            padding: 4px 10px; font-size: 12px;
            border: 1px solid #d0d7de; border-radius: 6px;
            background: #f6f8fa; color: #555; cursor: pointer; display: none;
        }
        .reset-btn.visible { display: inline-block; }
        .reset-btn:hover { background: #e9ecef; }
        canvas { max-height: 400px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${this.title}</h1>
            <p>生成时间: ${new Date().toLocaleString('zh-CN')}</p>
        </div>
        ${chartDivs}
    </div>
    <script>
        function resetZoom(canvasId, btnId) {
            Chart.getChart(canvasId).resetZoom();
            document.getElementById(btnId).classList.remove('visible');
        }
        const barTopLabels = {
            id: 'barTopLabels',
            afterDatasetsDraw(chart) {
                const { ctx } = chart;
                ctx.save();
                ctx.font = 'bold 11px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillStyle = '#444';
                chart.data.datasets.forEach((dataset, i) => {
                    if (dataset.type === 'line') return;
                    const meta = chart.getDatasetMeta(i);
                    meta.data.forEach((bar, index) => {
                        const value = dataset.data[index];
                        if (value > 0) {
                            ctx.fillText(value, bar.x, bar.y - 3);
                        }
                    });
                });
                ctx.restore();
            }
        };
        Chart.register(barTopLabels);
        ${chartScripts}
    </script>
</body>
</html>`;
  }

  generateScatterDiv(chart, index) {
    const opts = chart.options;
    return `
        <div class="chart-container">
            <div class="chart-title">${opts.title || '散点图'}</div>
            <button class="reset-btn" id="reset_${index}" onclick="resetZoom('chart_${index}','reset_${index}')">重置缩放</button>
            <p class="zoom-hint">拖拽选区放大 · 点击"重置缩放"还原</p>
            <canvas id="chart_${index}"></canvas>
        </div>`;
  }

  generateLineDiv(chart, index) {
    const opts = chart.options;
    return `
        <div class="chart-container">
            <div class="chart-title">${opts.title || '折线图'}</div>
            <button class="reset-btn" id="reset_${index}" onclick="resetZoom('chart_${index}','reset_${index}')">重置缩放</button>
            <p class="zoom-hint">拖拽选区放大 · 点击"重置缩放"还原</p>
            <canvas id="chart_${index}"></canvas>
        </div>`;
  }

  generateBarDiv(chart, index) {
    const opts = chart.options;
    return `
        <div class="chart-container">
            <div class="chart-title">${opts.title || '柱状图'}</div>
            <canvas id="chart_${index}"></canvas>
        </div>`;
  }

  generateScatterScript(chart, index) {
    const data = chart.data;
    const opts = chart.options;

    const xMin = opts.xRange?.min || Math.min(...data.map(d => d.x));
    const xMax = opts.xRange?.max || Math.max(...data.map(d => d.x));

    const logYMin = (opts.useLogScale && opts.yMin != null) ? opts.yMin : 'undefined';
    const yAxisStr = opts.useLogScale
      ? `{ type: 'logarithmic', min: ${logYMin}, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' }, ticks: { callback: function(v) { if (v < 1) return (v * 60).toFixed(0) + 's'; return (v < 10 ? v.toFixed(1) : Math.round(v)) + 'm'; } } }`
      : `{ min: ${opts.yMin != null ? opts.yMin : 0}, max: ${opts.yMax != null ? opts.yMax : 120}, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' } }`;

    // 准备散点数据
    const scatterPoints = data.map(d => ({
      x: d.x,
      y: d.y,
      height: d.height,
      interval: d.interval,
      zero: d.zero || d.isZero || false
    }));

    // 准备颜色
    const colors = data.map(d => {
      if (d.zero || d.isZero) return '#e74c3c';
      if (opts.colorFn) return opts.colorFn(d);
      return opts.color || '#3498db';
    });

    const pointStyles = data.map(d => (d.zero || d.isZero) ? 'star' : 'circle');
    const pointRadii = data.map(d => (d.zero || d.isZero) ? 7 : 3);

    const scatterDataStr = JSON.stringify(scatterPoints);
    const colorsStr = JSON.stringify(colors);
    const stylesStr = JSON.stringify(pointStyles);
    const radiiStr = JSON.stringify(pointRadii);

    let avgLineDataset = '';
    if (opts.avgLine !== undefined) {
      avgLineDataset = `{
            type: 'line',
            label: '${opts.avgLabel || '平均线'}',
            data: [{x: ${xMin}, y: ${opts.avgLine}}, {x: ${xMax}, y: ${opts.avgLine}}],
            borderColor: '${opts.avgColor || '#27ae60'}',
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 0,
            fill: false
        },`;
    }

    return `
(function() {
    const ctx = document.getElementById('chart_${index}').getContext('2d');
    const scatterData = ${scatterDataStr};
    const colors = ${colorsStr};
    const pointStyles = ${stylesStr};
    const pointRadii = ${radiiStr};

    new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                ${avgLineDataset}
                {
                    label: '数据',
                    data: scatterData,
                    backgroundColor: colors,
                    pointStyle: pointStyles,
                    pointRadius: pointRadii,
                    pointHoverRadius: pointRadii.map(r => r + 2),
                    showLine: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                zoom: {
                    zoom: {
                        drag: { enabled: true, borderColor: 'rgba(52,152,219,0.4)', borderWidth: 1, backgroundColor: 'rgba(52,152,219,0.08)' },
                        mode: 'x',
                        onZoomComplete({ chart }) {
                            document.getElementById('reset_${index}').classList.add('visible');
                        }
                    }
                },
                legend: { display: ${opts.avgLine !== undefined} },
                tooltip: {
                    callbacks: {
                        title: function(context) {
                            const p = context[0].raw;
                            return '高度: ' + p.height + ' | 时间: ' + new Date(p.x * 1000).toLocaleString('zh-CN');
                        },
                        label: function(context) {
                            const p = context.raw;
                            if (!p || p.interval === undefined) return null;
                            if (p.zero) return ['异常出块！', '实际间隔: ' + p.interval + ' 秒'];
                            const rate = 3600 / p.interval;
                            const mins = (p.interval / 60).toFixed(2);
                            return ['间隔: ' + p.interval + ' 秒 (' + mins + 'm)', '速率: ' + rate.toFixed(2) + ' 块/小时'];
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: ${xMin},
                    max: ${xMax},
                    title: { display: ${!!opts.xLabel}, text: '${opts.xLabel || ''}' },
                    ticks: {
                        callback: function(v) {
                            const d = new Date(v * 1000);
                            return (d.getMonth()+1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
                        }
                    }
                },
                y: ${yAxisStr}
            }
        }
    });
})();`;
  }

  generateLineScript(chart, index) {
    const opts = chart.options;
    const labelsStr = JSON.stringify(chart.labels);
    const dataStr = JSON.stringify(chart.data);
    const labelName = opts.label || '数据';

    return `
(function() {
    const ctx = document.getElementById('chart_${index}').getContext('2d');
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ${labelsStr},
            datasets: [{
                label: '${labelName}',
                data: ${dataStr},
                borderColor: '${opts.borderColor || 'rgb(102, 126, 234)'}',
                backgroundColor: '${opts.backgroundColor || 'rgba(102, 126, 234, 0.1)'}',
                borderWidth: 2,
                fill: ${opts.fill !== false},
                tension: ${opts.tension || 0.4},
                pointRadius: ${opts.pointRadius ?? 0},
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                zoom: {
                    zoom: {
                        drag: { enabled: true, borderColor: 'rgba(52,152,219,0.4)', borderWidth: 1, backgroundColor: 'rgba(52,152,219,0.08)' },
                        mode: 'x',
                        onZoomComplete({ chart }) {
                            document.getElementById('reset_${index}').classList.add('visible');
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        title: function(items) { return items[0].label; },
                        label: function(item) { return '${labelName}: ' + item.raw; }
                    }
                }
            },
            scales: {
                x: { title: { display: ${!!opts.xLabel}, text: '${opts.xLabel || ''}' }, ticks: { maxTicksLimit: 20 } },
                y: { beginAtZero: true, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' } }
            }
        }
    });
})();`;
  }

  generateBarScript(chart, index) {
    const opts = chart.options;
    const labelsStr = JSON.stringify(chart.labels);
    const dataStr = JSON.stringify(chart.data);

    const bgColors = opts.colors || opts.color || 'rgba(102, 126, 234, 0.7)';
    const bgColorsStr = Array.isArray(bgColors) ? JSON.stringify(bgColors) : `'${bgColors}'`;
    const showBarTopLabels = opts.showBarTopLabels !== false;
    const binRangesStr = opts.binRanges ? JSON.stringify(opts.binRanges) : 'null';
    const totalCount = opts.totalCount || 0;

    const normalCurveDataset = opts.normalCurve ? `,{
            type: 'line',
            label: '正态分布拟合',
            data: ${JSON.stringify(opts.normalCurve)},
            borderColor: '#e74c3c',
            backgroundColor: 'rgba(231,76,60,0.07)',
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.4,
            order: 0
        }` : '';

    return `
(function() {
    const ctx = document.getElementById('chart_${index}').getContext('2d');
    const binRanges = ${binRangesStr};
    const totalCount = ${totalCount};
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ${labelsStr},
            datasets: [{
                label: '${opts.label || '频次'}',
                data: ${dataStr},
                backgroundColor: ${bgColorsStr},
                borderColor: '${opts.borderColor || 'rgb(102, 126, 234)'}',
                borderWidth: 1,
                order: 1
            }${normalCurveDataset}]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                barTopLabels: ${showBarTopLabels ? '{}' : 'false'},
                legend: { display: ${!!opts.normalCurve} },
                tooltip: {
                    callbacks: {
                        title: function(items) {
                            const i = items[0].dataIndex;
                            if (!binRanges || !binRanges[i]) return items[0].label;
                            const r = binRanges[i];
                            const minSec = r.min, maxSec = r.max;
                            const minM = (minSec / 60).toFixed(1);
                            if (maxSec === null || maxSec === Infinity) return minSec + 's (' + minM + 'm) 以上';
                            const maxM = (maxSec / 60).toFixed(1);
                            return minSec + 's ~ ' + maxSec + 's  (' + minM + 'm ~ ' + maxM + 'm)';
                        },
                        label: function(item) {
                            if (item.dataset.label === '正态分布拟合') return '正态期望: ' + Number(item.raw).toFixed(1);
                            if (totalCount > 0) {
                                const pct = (item.raw / totalCount * 100).toFixed(1);
                                return item.dataset.label + ': ' + item.raw + '  (' + pct + '%)';
                            }
                            return item.dataset.label + ': ' + item.raw;
                        }
                    }
                }
            },
            scales: {
                x: { title: { display: ${!!opts.xLabel}, text: '${opts.xLabel || ''}' }, ticks: { maxRotation: 45 } },
                y: { beginAtZero: true, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' } }
            }
        }
    });
})();`;
  }

  save(filename, outputDir = './reports') {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, this.generateHTML());
    return filepath;
  }
}

module.exports = {
  ASCIIChart,
  ScatterTimeChart,
  LineChart,
  BarChart,
  HTMLChartBuilder,

  scatterTime: (data, options) => new ScatterTimeChart(options?.width, options?.height).draw(data, options),
  line: (data, labels, options) => new LineChart(options?.width, options?.height).draw(data, labels, options),
  bar: (data, options) => new BarChart(options?.width, options?.height).draw(data, options),
  htmlBuilder: () => new HTMLChartBuilder()
};
