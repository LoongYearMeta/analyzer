# Chain Analyzer

一个插件化的区块链数据分析框架，支持比特币等 UTXO 链的区块数据分析。

## 核心特性

- **插件化架构**: 新增分析器只需添加文件到 `analyzers/` 目录，框架自动发现
- **双重执行模式**:
  - **独立执行**: 每个分析器可单独运行，自带绘图
  - **框架组合**: 多个分析器组合运行，框架统一生成报告
- **多输出格式**: 控制台文本统计 + ASCII 图表 + HTML 交互式图表

## 快速开始

### 环境配置

```bash
export RPC_URL="http://localhost:8332"
export RPC_USER="your_username"
export RPC_PASS="your_password"
```

### 运行分析

```bash
# 查看所有可用分析器
./framework.js --list

# 运行单个分析器（仅文本输出）
./framework.js tx-count --start 824190 --end 824200

# 生成 HTML 图表报告
./framework.js tx-count --start 824190 --end 824200 --html

# 同时显示 ASCII 图表（终端内）
./framework.js tx-count --start 824190 --end 824200 --chart

# 组合多个分析器，生成统一报告
./framework.js tx-count,block-interval --start 824190 --html

# 运行所有分析器
./framework.js all --start 824190 --end 824200 --html
```

### 独立运行分析器

```bash
# 交易数量分析（带图表）
node analyzers/tx-count.js --start 824190 --end 824200 --html --chart

# 出块间隔分析（时间轴散点图）
node analyzers/block-interval.js --start 824190 --end 824200 --html --chart

# 祖先深度分析
node analyzers/ancestor-depth.js --start 824190 --end 824195 --html
```

## 如何查看图表

### 方法一：终端 ASCII 图表（--chart）

添加 `--chart` 参数，图表直接显示在终端中：

```bash
./framework.js block-interval --start 824190 --end 824200 --chart
```

输出示例：
```
※ '*' = 异常出块（0秒或负数） | X轴：时间轴
↑ 慢出块 ← 时间 → ↓ 快出块

  │                                       *
  │     █                                 │
  │      █                                │
  │       █                        █      │
  └───────────────────────────────────────┘
   03-25 10:00    03-25 11:00    03-25 12:00
```

### 方法二：HTML 交互式图表（--html）

添加 `--html` 参数生成交互式图表：

```bash
./framework.js tx-count --start 824190 --end 824200 --html
```

执行后会输出生成的文件路径：
```
════════════════════════════════════════════════════════════
📄 统一 HTML 报告已保存: /path/to/reports/unified_report_1234567890.html
════════════════════════════════════════════════════════════
```

**打开方式**：
- **命令行**: `open reports/unified_report_*.html` (macOS) 或 `xdg-open reports/unified_report_*.html` (Linux)
- **浏览器**: 直接双击 HTML 文件，或将路径粘贴到浏览器地址栏（以 `file://` 开头）
- **VS Code**: 右键 HTML 文件 → "Open with Live Server"（需安装插件）

HTML 报告包含：
- 交互式 Chart.js 图表（缩放、悬停提示）
- 统计概览卡片
- 支持多分析器结果组合展示

## 分析器列表

| 分析器 | ID | 功能描述 | 图表类型 |
|--------|-----|----------|----------|
| 📦 交易数量 | `tx-count` | 统计区块交易数量分布和趋势 | 折线图 + 柱状分布图 |
| ⏱️ 出块间隔 | `block-interval` | 分析出块时间间隔和速率 | 时间轴散点图 + 分布图 |
| 🌳 祖先深度 | `ancestor-depth` | 分析交易祖先引用链深度 | 多折线图 + 深度分布图 |

## 项目结构

```
chain-analyzer/
├── framework.js           # 框架主入口
├── lib/
│   ├── rpc.js            # RPC 客户端（缓存、批处理）
│   ├── stats.js          # 统计计算工具
│   ├── reporter.js       # 控制台输出
│   └── charts.js         # 绘图模块（ASCII + HTML）
├── analyzers/            # 分析器目录
│   ├── tx-count.js
│   ├── ancestor-depth.js
│   └── block-interval.js
└── reports/              # 报告输出目录（自动生成）
```

## 命令行选项

### 全局选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--start` | `-s` | 起始区块高度 |
| `--end` | `-e` | 结束区块高度 |
| `--html` | | 生成 HTML 交互式图表报告 |
| `--chart` | | 在终端显示 ASCII 图表 |
| `--output-dir` | `-o` | 报告输出目录（默认：`./reports`） |
| `--list` | `-l` | 列出所有可用分析器 |
| `--silent` | | 静默模式（减少输出） |

### 分析器特有选项

| 分析器 | 选项 | 说明 |
|--------|------|------|
| `ancestor-depth` | `--verbose, -v` | 显示详细进度 |
| `block-interval` | `--rate` | 显示速率分析 |

## 添加新分析器

1. 在 `analyzers/` 目录创建新文件
2. 导出 `info`（元信息）和 `analyze`（分析函数）
3. 使用 `lib/charts.js` 进行绘图
4. 支持独立运行（添加 `if (require.main === module)`）

框架会自动发现新分析器，无需修改主框架代码。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `RPC_URL` | RPC 服务器地址 | `http://localhost:8332` |
| `RPC_USER` | RPC 用户名 | `username` |
| `RPC_PASS` | RPC 密码 | `randompasswd` |

## 使用示例

### 查看出块间隔趋势

```bash
# 分析最近100个区块的出块间隔，生成 HTML 报告
./framework.js block-interval --html

# 指定范围，同时显示终端图表
./framework.js block-interval --start 824000 --end 824100 --html --chart
```

### 对比多个指标

```bash
# 同时分析交易数量和出块间隔，生成组合报告
./framework.js tx-count,block-interval --start 824190 --end 824290 --html

# 报告将包含两个分析器的图表，可在浏览器中对比查看
```

### 监控模式（定期分析）

```bash
# 分析最近区块并立即打开报告
./framework.js block-interval --html && open reports/*.html
```

## 许可证

MIT
