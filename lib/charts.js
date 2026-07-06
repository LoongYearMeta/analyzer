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
      options: { ...options, timeAxis: true }
    });
    return this;
  }

  addScatterChart(data, options = {}) {
    this.charts.push({
      type: 'scatter',
      data,
      options: { ...options, timeAxis: false }
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

  /**
   * 出块间隔「概率分布」图（线性时间轴 + 概率密度，曲线下面积=出块概率）。
   * 与 addBarChart 的频次直方图不同：纵轴是概率密度而非频次；指数密度 f(t)=λe^(−λt)
   * 从 t=0 单调衰减。按调用方给定的分割点把横轴切成若干区间，每个区带标出该区间的
   * 出块概率（实测 vs BTC 理论），并叠加实测分箱密度圆点做形状比对。
   * @param {Object} options - {
   *   title, caption, xLabel, yLabel,
   *   counts:[],        // 各 bin 频次（含末尾 >outlier 开箱，可选）— 仅用于画分箱密度点
   *   closedBins,       // 闭箱个数（不含开箱）
   *   totalCount: N,    // 样本数
   *   binWidth,         // bin 宽(秒)
   *   muSelf,           // 实测均值(秒) → λ_self=1/μ
   *   btcTarget,        // BTC 目标间隔(秒)，默认 600 → λ_btc=1/600
   *   xMinM,            // 横轴下界(分钟)，默认 0
   *   xMaxM,            // 横轴上界(分钟)，默认 45
   *   boldLineMin,      // 加粗分割线位置(分钟)，默认 10
   *   dividers:[],      // 分割线位置(分钟)，默认 [1,10,30]
   *   regions:[],       // 区带 [{name,x0,x1(分钟),emp,btc(0~1概率),fill,line}]
   *   cornerNotes:[],   // 左上角注 [{text,color}]（如 ≤1m 概率、≤0 间隔说明）
   *   dualAxis          // 实测峰值远高于 BTC 理论峰值时启用右轴，避免理论曲线被压扁
   * }
   */
  addProbDistChart(options = {}) {
    this.charts.push({ type: 'probdist', options });
    return this;
  }

  /**
   * 多序列折线图。
   * @param {Array} labels - X 轴标签
   * @param {Array} datasets - [{ label, data:[], color, dash:[], pointRadius }]
   * @param {Object} options - { title, xLabel, yLabel, tension }
   */
  addMultiLineChart(labels, datasets, options = {}) {
    this.charts.push({
      type: 'multiline',
      labels,
      datasets,
      options
    });
    return this;
  }

  addNote(html) {
    this.charts.push({ type: 'note', html });
    return this;
  }

  generateHTML() {
    const chartDivs = this.charts.map((chart, i) => {
      if (chart.type === 'scatter') {
        return this.generateScatterDiv(chart, i);
      } else if (chart.type === 'line') {
        return this.generateLineDiv(chart, i);
      } else if (chart.type === 'multiline') {
        return this.generateLineDiv(chart, i);
      } else if (chart.type === 'bar') {
        return this.generateBarDiv(chart, i);
      } else if (chart.type === 'probdist') {
        return this.generateProbDistDiv(chart, i);
      } else if (chart.type === 'note') {
        return `<div class="note-block">${chart.html}</div>`;
      }
      return '';
    }).join('\n');

    const chartScripts = this.charts.map((chart, i) => {
      if (chart.type === 'scatter') {
        return this.generateScatterScript(chart, i);
      } else if (chart.type === 'line') {
        return this.generateLineScript(chart, i);
      } else if (chart.type === 'multiline') {
        return this.generateMultiLineScript(chart, i);
      } else if (chart.type === 'bar') {
        return this.generateBarScript(chart, i);
      } else if (chart.type === 'probdist') {
        return this.generateProbDistScript(chart, i);
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
        .chart-desc { font-size: 13px; line-height: 1.7; color: #666; background: #f7f9fc;
            border-left: 3px solid #d6e0f0; padding: 8px 12px; margin: 0 0 12px 0; border-radius: 0 4px 4px 0; }
        .chart-desc b, .chart-desc strong { color: #444; }
        .note-block {
            background: #f8f9fa; border-left: 4px solid #667eea;
            border-radius: 0 8px 8px 0; padding: 16px 20px; margin: 0 0 24px 0;
            font-size: 14px; line-height: 1.8; color: #333;
        }
        .note-block h3 { margin: 0 0 10px 0; color: #444; font-size: 15px; }
        .note-block table { border-collapse: collapse; margin: 10px 0; width: auto; }
        .note-block th, .note-block td { border: 1px solid #dde; padding: 5px 14px; font-size: 13px; }
        .note-block th { background: #eef; }
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
                // 仅给柱状图打顶部数字标签。此插件是全局注册的，会跑在每张图上；
                // 必须用「图表类型」判定（line/scatter 图的 type 在 chart 上、不在 dataset 上），
                // 否则会把数值画到折线/散点的每个点上，污染难度图等。
                if (chart.config.type !== 'bar') return;
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
            ${opts.caption ? `<div class="chart-desc">${opts.caption}</div>` : ''}
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

  generateProbDistDiv(chart, index) {
    const opts = chart.options;
    return `
        <div class="chart-container">
            <div class="chart-title">${opts.title || '出块间隔概率分布'}</div>
            ${opts.caption ? `<div class="chart-desc">${opts.caption}</div>` : ''}
            <canvas id="chart_${index}"></canvas>
        </div>`;
  }

  generateScatterScript(chart, index) {
    const data = chart.data;
    const opts = chart.options;
    const isTimeAxis = opts.timeAxis !== false;

    const xMin = opts.xRange?.min || Math.min(...data.map(d => d.x));
    const xMax = opts.xRange?.max || Math.max(...data.map(d => d.x));
    const yMin = opts.yMin != null ? opts.yMin : 0;
    const hasYMax = opts.yMax != null;

    const logYMin = (opts.useLogScale && opts.yMin != null) ? opts.yMin : 'undefined';
    const yAxisStr = opts.useLogScale
      ? `{ type: 'logarithmic', min: ${logYMin}, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' }, ticks: { callback: function(v) { if (v < 1) return (v * 60).toFixed(0) + 's'; return (v < 10 ? v.toFixed(1) : Math.round(v)) + 'm'; } } }`
      : `{ type: 'linear', min: ${yMin}${hasYMax ? `, max: ${opts.yMax}` : ''}, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' } }`;

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

    const baseRadius = opts.pointRadius ?? 3;
    const pointStyles = data.map(d => (d.zero || d.isZero) ? 'star' : 'circle');
    const pointRadii = data.map(d => (d.zero || d.isZero) ? 7 : baseRadius);

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
                            if (${isTimeAxis}) {
                                return '高度: ' + p.height + ' | 时间: ' + new Date(p.x * 1000).toLocaleString('zh-CN');
                            }
                            const xLabel = ${JSON.stringify(opts.xLabel || 'X')};
                            const xValue = typeof p.x === 'number' ? p.x.toLocaleString('en-US') : p.x;
                            const parts = [xLabel + ': ' + xValue];
                            if (p.height != null) parts.push('高度: #' + p.height);
                            return parts.join(' | ');
                        },
                        label: function(context) {
                            const p = context.raw;
                            if (!p) return null;
                            if (${isTimeAxis}) {
                                if (p.interval === undefined) return null;
                                if (p.zero) return ['异常出块！', '实际间隔: ' + p.interval + ' 秒'];
                                const rate = 3600 / p.interval;
                                const mins = (p.interval / 60).toFixed(2);
                                return ['间隔: ' + p.interval + ' 秒 (' + mins + 'm)', '速率: ' + rate.toFixed(2) + ' 块/小时'];
                            }
                            const yLabel = ${JSON.stringify(opts.yLabel || '值')};
                            const yValue = typeof p.y === 'number' ? p.y.toLocaleString('en-US') : p.y;
                            const lines = [yLabel + ': ' + yValue];
                            if (p.height != null) lines.push('高度: #' + p.height);
                            return lines;
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
                            if (!${isTimeAxis}) return Number(v).toLocaleString('en-US');
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
                showLine: ${opts.showLine !== false},
                pointBackgroundColor: '${opts.borderColor || 'rgb(102, 126, 234)'}',
                pointRadius: ${opts.pointRadius ?? 0},
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: '${opts.showLine === false ? 'nearest' : 'index'}', intersect: ${opts.showLine === false} },
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
                        label: function(item) { const v = item.raw; return '${labelName}: ' + (typeof v === 'number' ? v.toLocaleString('en-US') : v); }
                    }
                }
            },
            scales: {
                x: { title: { display: ${!!opts.xLabel}, text: '${opts.xLabel || ''}' }, ticks: { maxTicksLimit: 20 } },
                y: { beginAtZero: ${opts.beginAtZero !== false}, title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' },
                     ticks: { display: ${opts.hideYTicks !== true} } }
            }
        }
    });
})();`;
  }

  generateMultiLineScript(chart, index) {
    const opts = chart.options;
    const labelsStr = JSON.stringify(chart.labels);
    const palette = ['#3498db', '#e74c3c', '#27ae60', '#f39c12', '#9b59b6', '#16a085'];

    const datasetsStr = chart.datasets.map((ds, di) => {
      const color = ds.color || palette[di % palette.length];
      return `{
            label: ${JSON.stringify(ds.label || ('序列' + (di + 1)))},
            data: ${JSON.stringify(ds.data)},
            borderColor: '${color}',
            backgroundColor: '${color}',
            pointBackgroundColor: '${color}',
            yAxisID: '${ds.yAxisID || 'y'}',
            showLine: ${ds.showLine !== false},
            borderWidth: 2,
            borderDash: ${JSON.stringify(ds.dash || [])},
            fill: false,
            spanGaps: ${ds.spanGaps !== undefined ? ds.spanGaps : true},
            tension: ${opts.tension ?? 0.2},
            pointRadius: ${ds.pointRadius ?? 2},
            pointHoverRadius: 5
        }`;
    }).join(',');

    return `
(function() {
    const ctx = document.getElementById('chart_${index}').getContext('2d');
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ${labelsStr},
            datasets: [${datasetsStr}]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true },
                zoom: {
                    zoom: {
                        drag: { enabled: true, borderColor: 'rgba(52,152,219,0.4)', borderWidth: 1, backgroundColor: 'rgba(52,152,219,0.08)' },
                        mode: 'x',
                        onZoomComplete({ chart }) {
                            document.getElementById('reset_${index}').classList.add('visible');
                        }
                    }
                }
            },
            scales: {
                x: { title: { display: ${!!opts.xLabel}, text: '${opts.xLabel || ''}' }, ticks: { maxTicksLimit: 20 } },
                y: { position: 'left', title: { display: ${!!opts.yLabel}, text: '${opts.yLabel || ''}' } }${opts.y1Label ? `,
                y1: { position: 'right', title: { display: true, text: '${opts.y1Label}' }, grid: { drawOnChartArea: false } }` : ''}
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
            label: ${JSON.stringify(opts.normalCurveLabel || '正态分布拟合（实测）')},
            data: ${JSON.stringify(opts.normalCurve)},
            borderColor: '#e74c3c',
            backgroundColor: 'rgba(231,76,60,0.07)',
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.4,
            order: 0
        }` : '';

    const normalCurve2Dataset = opts.normalCurve2 ? `,{
            type: 'line',
            label: ${JSON.stringify(opts.normalCurve2Label || '指数分布参考（PoW理论 λ=1/600）')},
            data: ${JSON.stringify(opts.normalCurve2)},
            borderColor: '#9b59b6',
            backgroundColor: 'rgba(155,89,182,0.05)',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false,
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
            }${normalCurveDataset}${normalCurve2Dataset}]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                barTopLabels: ${showBarTopLabels ? '{}' : 'false'},
                legend: { display: ${!!(opts.normalCurve || opts.normalCurve2)} },
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
                            if (item.dataset.type === 'line') return (item.dataset.label || '').split('（')[0] + ' 期望: ' + Number(item.raw).toFixed(1);
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

  generateProbDistScript(chart, index) {
    const o = chart.options;
    const N = o.totalCount || 0;
    const dt = o.binWidth || 1;
    const counts = Array.isArray(o.counts) ? o.counts : [];
    const closedBins = o.closedBins != null ? o.closedBins : counts.length;
    const muSelf = o.muSelf || 600;
    const btcTarget = o.btcTarget || 600;
    const xMaxM = o.xMaxM || 45;
    const boldLine = o.boldLineMin != null ? o.boldLineMin : 10;
    const dividers = o.dividers || [1, 10, 30];
    const regions = o.regions || [];
    const cornerNotes = o.cornerNotes || [];
    const xMinM = o.xMinM != null ? o.xMinM : 0;
    const xLabel = o.xLabel || '出块间隔 t（分钟）';
    const yLabel = o.yLabel || '概率密度 [1/分钟]（面积=概率，非高度）';
    const dualAxis = o.dualAxis !== false;

    return `
(function() {
    const ctx = document.getElementById('chart_${index}').getContext('2d');

    const N = ${N}, dt = ${dt}, closedBins = ${closedBins}, xMinM = ${xMinM}, xMaxM = ${xMaxM};
    const counts = ${JSON.stringify(counts)};
    // λ 以"每分钟"为单位；线性轴上 f(t)=λe^(−λt)，曲线下某区间面积 = 该区间出块概率
    const lamBtc = 1 / (${btcTarget} / 60);
    const f = (t, lam) => lam * Math.exp(-lam * t);

    // BTC 理论平滑曲线（线性密集采样）
    const steps = 300, curveBtc = [];
    for (let i = 0; i <= steps; i++) {
        const xm = xMaxM * i / steps;
        curveBtc.push({ x: xm, y: f(xm, lamBtc) });
    }

    // 实测分箱密度（圆点，分钟轴内）
    const empPts = [];
    for (let i = 0; i < closedBins; i++) {
        const cmin = ((i + 0.5) * dt) / 60;
        if (cmin > xMaxM) break;
        empPts.push({ x: cmin, y: N > 0 ? (counts[i] / N) / (dt / 60) : 0 });
    }
    const btcPeak = f(0, lamBtc);
    const empPeak = empPts.reduce((m, p) => Math.max(m, p.y || 0), 0);
    const useDualAxis = ${dualAxis} && empPeak > btcPeak * 5;

    const REGIONS = ${JSON.stringify(regions)};
    const cornerNotes = ${JSON.stringify(cornerNotes)};
    const dividers = ${JSON.stringify(dividers)};
    const boldLine = ${boldLine};
    const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '样本不足';

    // 自定义插件：四区带底色 + 分割线（10min 加粗）+ 各区间概率标签
    const regionPlugin = {
        id: 'blockRegions',
        beforeDatasetsDraw(chart) {
            const { ctx, chartArea: a, scales: { x } } = chart;
            ctx.save();
            REGIONS.forEach(r => {
                const px0 = Math.max(a.left, x.getPixelForValue(r.x0));
                const px1 = Math.min(a.right, x.getPixelForValue(r.x1));
                ctx.fillStyle = r.fill;
                ctx.fillRect(px0, a.top, px1 - px0, a.bottom - a.top);
            });
            dividers.forEach(d => {
                const px = x.getPixelForValue(d), bold = d === boldLine;
                ctx.strokeStyle = bold ? 'rgba(40,40,40,0.85)' : 'rgba(120,120,120,0.5)';
                ctx.lineWidth = bold ? 2 : 1;
                ctx.setLineDash(bold ? [] : [4, 4]);
                ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
                if (bold) {
                    ctx.fillStyle = 'rgba(40,40,40,0.9)'; ctx.font = 'bold 12px sans-serif';
                    ctx.textAlign = 'left'; ctx.fillText(' 目标 ' + boldLine + 'min', px + 4, a.bottom - 8);
                }
            });
            ctx.restore();
        },
        afterDatasetsDraw(chart) {
            const { ctx, chartArea: a, scales: { x } } = chart;
            ctx.save();
            // 角注（左上、左对齐）：例如 ≤1m 概率、≤0 间隔说明
            ctx.textAlign = 'left';
            let cy = a.top + 13;
            cornerNotes.forEach(n => {
                ctx.fillStyle = n.color || '#444'; ctx.font = 'bold 12px sans-serif';
                ctx.fillText(n.text, a.left + 6, cy);
                cy += 16;
            });
            if (useDualAxis) {
                ctx.fillStyle = '#777'; ctx.font = 'bold 12px sans-serif';
                ctx.fillText('左轴=BTC理论密度；右轴=实测密度', a.left + 6, cy);
                cy += 16;
            }
            const labelTop = cy + 6;
            // 区带标签（各区带中心、自动避开角注下移）
            ctx.textAlign = 'center';
            REGIONS.forEach(r => {
                const cx = (Math.max(r.x0, xMinM) + Math.min(r.x1, xMaxM)) / 2;
                const px = x.getPixelForValue(cx);
                let yy = labelTop;
                ctx.fillStyle = r.line; ctx.font = 'bold 12px sans-serif';
                ctx.fillText(r.name, px, yy);
                yy += 16; ctx.font = '12px sans-serif';
                ctx.fillStyle = '#333'; ctx.fillText('实测 ' + pct(r.emp), px, yy);
                yy += 15; ctx.fillStyle = '#888'; ctx.fillText('BTC ' + pct(r.btc), px, yy);
            });
            ctx.restore();
        }
    };

    new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    type: 'line', label: 'BTC 理论曲线',
                    data: curveBtc, parsing: false, yAxisID: 'yBtc',
                    borderColor: '#2980b9', backgroundColor: 'rgba(41,128,185,0.10)',
                    borderWidth: 2, pointRadius: 0, fill: true, tension: 0, order: 1,
                },
                {
                    type: 'line', label: '本链实测',
                    data: empPts, parsing: false, yAxisID: useDualAxis ? 'yEmp' : 'yBtc',
                    borderColor: '#e74c3c', backgroundColor: '#e74c3c',
                    borderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
                    pointBackgroundColor: '#e74c3c', fill: false, tension: 0, order: 0,
                },
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true },
                tooltip: {
                    callbacks: {
                        title: items => { const xm = items[0].parsed.x; return xm < 1 ? (xm * 60).toFixed(0) + 's' : xm.toFixed(1) + 'm'; },
                        label: item => item.dataset.label + ' · 密度 ' + Number(item.parsed.y).toFixed(4),
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear', min: ${xMinM}, max: xMaxM,
                    title: { display: true, text: ${JSON.stringify(xLabel)} },
                    ticks: { stepSize: 5, callback: v => v + 'm' },
                },
                yBtc: {
                    type: 'linear', position: 'left', beginAtZero: true,
                    max: useDualAxis ? btcPeak * 1.08 : undefined,
                    title: { display: true, text: useDualAxis ? 'BTC理论密度 [1/分钟]' : ${JSON.stringify(yLabel)} }
                },
                yEmp: {
                    type: 'linear', position: 'right', beginAtZero: true,
                    display: useDualAxis,
                    grid: { drawOnChartArea: false },
                    title: { display: useDualAxis, text: '实测密度 [1/分钟]' }
                }
            }
        },
        plugins: [regionPlugin]
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
