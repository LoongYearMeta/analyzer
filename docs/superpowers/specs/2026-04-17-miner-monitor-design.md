# Miner Monitor 设计文档

**日期**: 2026-04-17  
**目标**: 为 `../tx-height-test/miner-bridge.js` 添加实时伴随式分析可视化

---

## 背景与目标

miner-bridge.js 每轮（每个新区块）生成 mesh 交易森林 → 分两阶段广播 → 截取 getblocktemplate → CPUMiner 挖块。事后无法重建"哪些交易在同一批内存池被打包"，因为出块后内存池状态消失。因此需要与 miner-bridge **同步运行**的实时分析程序，在 `hashblock` 瞬间固定内存池快照。

---

## 核心原则

- **不信任原则**：analyzer 不依赖 miner-bridge 事件文件即可独立运行（ZMQ 优先）
- **最小耦合**：miner-bridge.js 仅追加事件到 `.jsonl` 文件（一行代码），无其他交集
- **懒惰式设计**：运行期间只持久化，不主动汇总；手动退出时生成 HTML 报告
- **永久化**：SQLite 存储所有轮次数据，支持后续重分析和复现

---

## 架构

```
TBC Node
  ├─ ZMQ hashblock ──────────────────────────────┐
  ├─ ZMQ hashtx (mempool 追踪) ──────────────────┤
  └─ RPC (getblock / getrawmempool) ─────────────┤
                                                  ▼
miner-bridge-events.jsonl (可选)        miner-monitor.js
  └─ fs.watch ───────────────────────────────────┤
                                                  │
                                         ┌────────┴────────┐
                                    SQLite DB          Terminal Dashboard
                                  (rounds/events)      (htop 风格，覆盖刷新)
                                                         │
                                              Ctrl+C → HTML 汇总报告
```

### 数据流

1. 启动：订阅 ZMQ `hashblock` + `hashtx`，维护内存池镜像（Map: txid → 入池时间戳）
2. `hashtx`：记录 txid 入池时间
3. `hashblock`：
   - 定格内存池快照
   - `getblock` 拿区块 txid 列表
   - 差集计算 → 确认打包集合 vs 留池集合
   - 关联 miner-bridge 事件（若存在）
   - 批量写入 SQLite
4. 终端仪表盘每 500ms 覆盖刷新
5. Ctrl+C → 生成 HTML 汇总报告

---

## miner-bridge.js 改动

在 4 个关键点各追加一行事件，提取为工具函数：

```js
function appendEvent(obj) {
    fs.appendFileSync('miner-bridge-events.jsonl',
        JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}
```

触发点：
- `round_start`：新块检测，含 `height`
- `phase1_stop`：阶段1停止，含 `height`, `n`, `h`, `m`, `sent`, `ok`, `fail`
- `phase2_done`：阶段2完成，含 `height`, `sent`, `ok`, `fail`
- `block_mined`：出块确认，含 `height`, `new_height`

---

## SQLite Schema

```sql
CREATE TABLE rounds (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    height              INTEGER NOT NULL,
    block_hash          TEXT NOT NULL,
    block_time          INTEGER,
    detected_at         INTEGER,
    mempool_size_before INTEGER,
    mempool_size_after  INTEGER,
    block_tx_count      INTEGER,
    packed_from_pool    INTEGER,
    -- miner-bridge 可选字段
    mb_n                INTEGER,
    mb_h                INTEGER,
    mb_m                INTEGER,
    mb_gen_ms           INTEGER,
    mb_phase1_sent      INTEGER,
    mb_phase1_ok        INTEGER,
    mb_phase2_sent      INTEGER,
    mb_phase2_ok        INTEGER,
    mb_mine_ms          INTEGER
);

CREATE TABLE mempool_txs (
    round_id    INTEGER REFERENCES rounds(id),
    txid        TEXT NOT NULL,
    entered_at  INTEGER,
    packed      INTEGER NOT NULL  -- 0=留池 1=打包
);
```

---

## 终端仪表盘

```
═══════════════════ Miner Monitor ════════════════════
 高度    区块哈希(短)   池前   池后   打包   模式
 824382  3a7f...c2     8421   312    8109   ZMQ+MB
 824383  9e1d...44     5103   4201   902    ZMQ only
 824384  [当前轮进行中...]
──────────────────────────────────────────────────────
 运行轮数: 3   总打包: 9011   平均打包率: 89%
 MB事件: ✓ 已连接          ZMQ: ✓ 已连接
══════════════════════════════════════════════════════
```

刷新间隔：500ms，ANSI 转义码覆盖重绘。

---

## HTML 汇总报告（Ctrl+C 触发）

- 统计卡片：总轮数、总打包 tx 数、平均内存池大小、ZMQ 模式 vs MB 增强模式轮数
- 折线图：每轮打包数量趋势
- 散点图：内存池大小 vs 打包率
- miner-bridge 可用时：h/m 分布图、阶段1/2广播成功率、各阶段耗时对比
- 原始数据表（可排序）

---

## 文件布局

```
analyzer/
├── analyzers/
│   └── miner-monitor.js       # 主程序（独立运行，不走框架）
├── lib/
│   └── zmq-client.js          # ZMQ 订阅封装
└── reports/
    └── miner-monitor-{ts}.db
    └── miner-monitor-{ts}.html

../tx-height-test/
└── miner-bridge.js            # 微改：+appendEvent 工具函数，4 处调用
    miner-bridge-events.jsonl  # 事件输出文件
```

---

## 依赖

- `zeromq`（npm）：ZMQ 客户端
- `better-sqlite3`（npm）：同步 SQLite，无 async 复杂度
- 已有：`axios`（RPC）

---

## 运行方式

```bash
# 两个终端分别启动
node analyzers/miner-monitor.js

# 可选参数
node analyzers/miner-monitor.js \
  --zmq tcp://localhost:28332 \
  --events ../tx-height-test/miner-bridge-events.jsonl \
  --db ./reports/miner-monitor.db
```
