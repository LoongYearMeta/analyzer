/**
 * 统计工具模块
 * 提供常用的统计计算方法
 */

/**
 * 计算平均值
 */
function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 计算中位数
 */
function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

/**
 * 计算众数
 * @returns {Object} { modes: [], count: 最大频次 }
 */
function mode(arr) {
    if (arr.length === 0) return { modes: [], count: 0 };

    const frequency = {};
    let maxCount = 0;

    for (const num of arr) {
        frequency[num] = (frequency[num] || 0) + 1;
        if (frequency[num] > maxCount) {
            maxCount = frequency[num];
        }
    }

    const modes = Object.entries(frequency)
        .filter(([_, count]) => count === maxCount)
        .map(([num, _]) => parseFloat(num));

    return { modes, count: maxCount };
}

/**
 * 计算百分位数
 */
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

/**
 * 计算标准差
 */
function stdDev(arr) {
    if (arr.length === 0) return 0;
    const avg = mean(arr);
    const variance = mean(arr.map(x => Math.pow(x - avg, 2)));
    return Math.sqrt(variance);
}

/**
 * 计算变异系数 (CV)
 */
function cv(arr) {
    if (arr.length === 0) return 0;
    const avg = mean(arr);
    if (avg === 0) return 0;
    return stdDev(arr) / avg;
}

/**
 * 计算范围统计
 */
function range(arr) {
    if (arr.length === 0) return { min: 0, max: 0, range: 0 };
    let min = arr[0];
    let max = arr[0];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] < min) min = arr[i];
        if (arr[i] > max) max = arr[i];
    }
    return { min, max, range: max - min };
}

/**
 * 计算分布直方图
 * @param {Array} arr - 数据数组
 * @param {Number} binCount - 分组数
 * @param {Array} customRanges - 自定义范围 [{min, max, label}, ...]
 */
function histogram(arr, binCount = 10, customRanges = null) {
    if (arr.length === 0) return [];

    if (customRanges) {
        return customRanges.map(r => ({
            label: r.label,
            min: r.min,
            max: r.max,
            count: arr.filter(x => x >= r.min && x <= r.max).length
        }));
    }

    const { min, max } = range(arr);
    const binSize = (max - min) / binCount || 1;
    const bins = [];

    for (let i = 0; i < binCount; i++) {
        const binMin = min + i * binSize;
        const binMax = min + (i + 1) * binSize;
        bins.push({
            label: `${binMin.toFixed(1)}-${binMax.toFixed(1)}`,
            min: binMin,
            max: binMax,
            count: arr.filter(x => x >= binMin && (i === binCount - 1 ? x <= binMax : x < binMax)).length
        });
    }

    return bins;
}

/**
 * 综合统计分析
 */
function analyze(arr) {
    if (arr.length === 0) {
        return {
            count: 0,
            mean: 0,
            median: 0,
            mode: { modes: [], count: 0 },
            stdDev: 0,
            cv: 0,
            min: 0,
            max: 0,
            p90: 0,
            p95: 0,
            p99: 0
        };
    }

    const modeResult = mode(arr);
    const rangeResult = range(arr);

    return {
        count: arr.length,
        mean: mean(arr),
        median: median(arr),
        mode: modeResult,
        stdDev: stdDev(arr),
        cv: cv(arr),
        min: rangeResult.min,
        max: rangeResult.max,
        p90: percentile(arr, 90),
        p95: percentile(arr, 95),
        p99: percentile(arr, 99)
    };
}

module.exports = {
    mean,
    median,
    mode,
    percentile,
    stdDev,
    cv,
    range,
    histogram,
    analyze
};
