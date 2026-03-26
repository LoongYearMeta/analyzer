#!/usr/bin/env node

/**
 * Chain Analyzer 框架
 *
 * 一个插件化的区块链数据分析框架，支持：
 * 1. 分析器独立运行（每个分析器可单独执行）
 * 2. 框架组合调用（多个分析器一起运行，统一报告）
 * 3. 统一绘图（框架使用 lib/charts.js 根据分析器数据绘图）
 *
 * 使用方式:
 *   ./framework.js --list                    # 列出所有可用分析器
 *   ./framework.js tx-count                  # 运行单个分析器
 *   ./framework.js tx-count,block-interval   # 组合运行多个分析器
 *   ./framework.js all                       # 运行所有分析器
 *   ./framework.js tx-count --start 824190   # 传递参数给分析器
 *
 * 环境变量:
 *   RPC_URL  - RPC地址 (默认: http://localhost:8332)
 *   RPC_USER - RPC用户名
 *   RPC_PASS - RPC密码
 */

const fs = require('fs');
const path = require('path');
const { RPCClient } = require('./lib/rpc');
const { Reporter } = require('./lib/reporter');
const { HTMLChartBuilder } = require('./lib/charts');

const ANALYZERS_DIR = path.join(__dirname, 'analyzers');

// ============ 分析器注册与管理 ============
class AnalyzerFramework {
    constructor() {
        this.analyzers = new Map();
        this.reporter = new Reporter();
    }

    /**
     * 发现并注册所有分析器
     */
    async discoverAnalyzers() {
        if (!fs.existsSync(ANALYZERS_DIR)) {
            throw new Error(`分析器目录不存在: ${ANALYZERS_DIR}`);
        }

        const files = fs.readdirSync(ANALYZERS_DIR)
            .filter(f => f.endsWith('.js'));

        for (const file of files) {
            try {
                const modulePath = path.join(ANALYZERS_DIR, file);
                const module = require(modulePath);

                if (module.info && module.analyze) {
                    this.analyzers.set(module.info.id, module);
                    this.analyzers.set(module.info.name, module);
                }
            } catch (err) {
                console.warn(`加载分析器 ${file} 失败:`, err.message);
            }
        }
    }

    /**
     * 获取所有已注册分析器
     */
    getAllAnalyzers() {
        const seen = new Set();
        return Array.from(this.analyzers.values()).filter(a => {
            if (seen.has(a.info.id)) return false;
            seen.add(a.info.id);
            return true;
        });
    }

    /**
     * 根据ID获取分析器
     */
    getAnalyzer(id) {
        return this.analyzers.get(id);
    }

    /**
     * 列出所有可用分析器
     */
    listAnalyzers() {
        const analyzers = this.getAllAnalyzers();

        console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║              🔗 Chain Analyzer - 可用分析器            ║');
        console.log('╚════════════════════════════════════════════════════════╝\n');

        analyzers.forEach((a, i) => {
            console.log(`${i + 1}. ${a.info.icon} ${a.info.name}`);
            console.log(`   ID: ${a.info.id}`);
            console.log(`   描述: ${a.info.description}`);
            console.log(`   版本: ${a.info.version || '1.0.0'}`);

            if (a.info.options && a.info.options.length > 0) {
                console.log('   选项:');
                a.info.options.forEach(opt => {
                    const alias = opt.alias ? `-${opt.alias}, ` : '    ';
                    const defaultVal = opt.default !== undefined ? ` (默认: ${opt.default})` : '';
                    console.log(`     ${alias}--${opt.name.padEnd(12)} ${opt.description}${defaultVal}`);
                });
            }
            console.log('');
        });

        console.log('组合使用示例:');
        console.log('  ./framework.js tx-count,block-interval --start 824190 --html');
        console.log('  ./framework.js all --start 824190 --end 824200 --html\n');
    }

    /**
     * 运行分析器
     */
    async run(analyzerIds, config = {}) {
        const results = [];

        let ids = [];
        if (analyzerIds === 'all') {
            ids = this.getAllAnalyzers().map(a => a.info.id);
        } else if (typeof analyzerIds === 'string') {
            ids = analyzerIds.split(',').map(id => id.trim());
        } else if (Array.isArray(analyzerIds)) {
            ids = analyzerIds;
        }

        if (ids.length === 0) {
            console.error('错误: 未指定分析器');
            this.listAnalyzers();
            return [];
        }

        const validIds = [];
        for (const id of ids) {
            const analyzer = this.getAnalyzer(id);
            if (!analyzer) {
                console.warn(`警告: 未知分析器 "${id}"，跳过`);
            } else {
                validIds.push(id);
            }
        }

        if (validIds.length === 0) {
            console.error('错误: 没有有效的分析器');
            return [];
        }

        this.reporter.title(`运行 ${validIds.length} 个分析器`);

        for (const id of validIds) {
            const analyzer = this.getAnalyzer(id);

            console.log(`\n${'─'.repeat(60)}`);
            console.log(`▶ ${analyzer.info.icon} ${analyzer.info.name} (${id})`);
            console.log(`${'─'.repeat(60)}`);

            try {
                const analyzerConfig = {
                    ...config,
                    rpc: config.rpc || {},
                    silent: false
                };

                const startTime = Date.now();
                const result = await analyzer.analyze(analyzerConfig);
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);

                console.log(`\n✓ 完成 (${duration}s)`);

                if (result) {
                    results.push(result);
                }
            } catch (err) {
                console.error(`\n✗ 失败: ${err.message}`);
            }
        }

        return results;
    }

    /**
     * 使用框架统一绘图生成 HTML 报告
     * 分析器提供数据，框架负责渲染
     */
    generateUnifiedReport(results, config = {}) {
        if (results.length === 0) return null;

        const builder = new HTMLChartBuilder();

        for (const result of results) {
            const { info, data, config: analyzerConfig } = result;
            const chartData = data.chartData;

            if (!chartData) continue;

            switch (info.id) {
                case 'block-interval':
                    // 时间轴散点图
                    if (chartData.scatter) {
                        builder.addScatterTimeChart(
                            chartData.scatter.map(d => ({
                                x: d.x,
                                y: d.y,
                                height: d.height,
                                interval: d.interval,
                                zero: d.isZero
                            })),
                            {
                                title: `${info.name} - 时间间隔散点图`,
                                height: 120,
                                avgLine: chartData.avgIntervalNorm,
                                avgLabel: '平均出块时间',
                                xLabel: '时间',
                                yLabel: '归一化间隔',
                                yMin: 0,
                                yMax: 120,
                                colorFn: (d) => chartData.getColor(d.interval),
                                pointStyleFn: (d) => d.zero ? 'star' : 'circle',
                                pointRadiusFn: (d) => d.zero ? 7 : 3
                            }
                        );
                    }
                    // 分布柱状图
                    if (chartData.distribution) {
                        builder.addBarChart(
                            chartData.distribution.map(d => d.label),
                            chartData.distribution.map(d => d.count),
                            {
                                title: `${info.name} - 间隔分布`,
                                height: 80,
                                xLabel: '时间间隔',
                                yLabel: '频次'
                            }
                        );
                    }
                    break;

                case 'tx-count':
                    // 交易数量趋势
                    if (chartData.trend) {
                        builder.addLineChart(
                            chartData.trend.labels,
                            chartData.trend.values,
                            {
                                title: `${info.name} - 交易数量趋势`,
                                height: 100,
                                label: '交易数量',
                                color: 'rgb(102, 126, 234)',
                                fill: true,
                                xLabel: '区块高度',
                                yLabel: '交易数量'
                            }
                        );
                    }
                    // 分布
                    if (chartData.distribution) {
                        builder.addBarChart(
                            chartData.distribution.map(d => d.label),
                            chartData.distribution.map(d => d.count),
                            {
                                title: `${info.name} - 数量分布`,
                                height: 80,
                                xLabel: '交易数量范围',
                                yLabel: '区块数量'
                            }
                        );
                    }
                    break;

                case 'ancestor-depth':
                    // 最大深度趋势
                    if (chartData.maxDepths) {
                        builder.addLineChart(
                            chartData.maxDepths.labels,
                            chartData.maxDepths.values,
                            {
                                title: `${info.name} - 最大深度趋势`,
                                height: 100,
                                label: '最大深度',
                                color: 'rgb(17, 153, 142)',
                                fill: true,
                                xLabel: '区块高度',
                                yLabel: '最大深度'
                            }
                        );
                    }
                    // 平均深度趋势
                    if (chartData.avgDepths) {
                        builder.addLineChart(
                            chartData.avgDepths.labels,
                            chartData.avgDepths.values,
                            {
                                title: `${info.name} - 平均深度趋势`,
                                height: 100,
                                label: '平均深度',
                                color: 'rgb(56, 239, 125)',
                                fill: true,
                                xLabel: '区块高度',
                                yLabel: '平均深度'
                            }
                        );
                    }
                    // 深度分布
                    if (chartData.distribution) {
                        builder.addBarChart(
                            chartData.distribution.slice(0, 30).map(d => d.label),
                            chartData.distribution.slice(0, 30).map(d => d.value),
                            {
                                title: `${info.name} - 深度分布`,
                                height: 100,
                                xLabel: '祖先深度',
                                yLabel: '交易数量'
                            }
                        );
                    }
                    break;
            }
        }

        // 保存报告
        const outputDir = config.outputDir || './reports';
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const filename = `unified_report_${Date.now()}.html`;
        const filepath = path.join(outputDir, filename);

        const html = builder
            .setTitle(`链分析报告 (${results.length} 项分析)`)
            .generateHTML();

        fs.writeFileSync(filepath, html);
        return filepath;
    }

    /**
     * 生成组合 HTML 报告（向后兼容）
     */
    generateCombinedReport(results, config = {}) {
        return this.generateUnifiedReport(results, config);
    }
}

// ============ 命令行解析 ============
function parseGlobalArgs() {
    const args = process.argv.slice(2);

    let analyzerArg = null;
    const config = {
        rpc: {},
        html: false,
        outputDir: './reports'
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (!arg.startsWith('-') && analyzerArg === null) {
            analyzerArg = arg;
            continue;
        }

        switch (arg) {
            case '--start':
            case '-s':
                config.start = parseInt(args[++i]);
                break;
            case '--end':
            case '-e':
                config.end = parseInt(args[++i]);
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
            case '--list':
            case '-l':
                config.list = true;
                break;
            case '--help':
            case '-h':
                config.help = true;
                break;
        }
    }

    return { analyzerArg, config };
}

function printUsage() {
    console.log(`
用法: ./framework.js [分析器列表] [全局选项] [分析器选项]

分析器列表:
  tx-count              区块交易数量分析
  ancestor-depth        交易祖先深度分析
  block-interval        出块间隔分析
  all                   运行所有分析器
  tx-count,block-interval  组合运行多个分析器（用逗号分隔）

全局选项:
  -s, --start <高度>     起始区块高度
  -e, --end <高度>       结束区块高度
      --html             生成统一 HTML 报告（框架统一绘图）
  -o, --output-dir <目录> 报告输出目录 (默认: ./reports)
  -l, --list             列出所有可用分析器
  -h, --help             显示帮助

RPC 选项:
      --rpc-url <地址>   RPC 地址
      --rpc-user <用户>  RPC 用户名
      --rpc-pass <密码>  RPC 密码

环境变量:
  RPC_URL, RPC_USER, RPC_PASS

示例:
  # 列出分析器
  ./framework.js --list

  # 运行单个分析器
  ./framework.js tx-count --start 824190 --end 824200

  # 组合分析，框架统一生成报告
  ./framework.js tx-count,block-interval --start 824190 --html

  # 运行所有分析器
  ./framework.js all --start 824190 --end 824200 --html

架构说明:
  - 分析器独立运行：node analyzers/xxx.js --html
    分析器自己调用 lib/charts.js 绘图

  - 框架组合运行：./framework.js xxx,yyy --html
    分析器返回数据，框架调用 lib/charts.js 统一绘图
    生成包含多个分析结果的统一报告
`);
}

// ============ 主入口 ============
async function main() {
    const framework = new AnalyzerFramework();

    // 发现分析器
    await framework.discoverAnalyzers();

    // 解析参数
    const { analyzerArg, config } = parseGlobalArgs();

    // 显示帮助
    if (config.help || (!analyzerArg && !config.list)) {
        printUsage();
        if (framework.getAllAnalyzers().length > 0) {
            framework.listAnalyzers();
        }
        return;
    }

    // 列出分析器
    if (config.list) {
        framework.listAnalyzers();
        return;
    }

    // 检查分析器
    if (framework.getAllAnalyzers().length === 0) {
        console.error('错误: 未找到任何分析器，请检查 analyzers/ 目录');
        return;
    }

    // 运行分析器
    const results = await framework.run(analyzerArg, config);

    // 生成统一报告
    if (config.html && results.length > 0) {
        const htmlPath = framework.generateUnifiedReport(results, config);
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`📄 统一 HTML 报告已保存: ${htmlPath}`);
        console.log(`${'═'.repeat(60)}\n`);
    }

    console.log(`完成! 成功运行 ${results.length} 个分析器`);
}

// 运行主程序
main().catch(err => {
    console.error('框架错误:', err.message);
    process.exit(1);
});
