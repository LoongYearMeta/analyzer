# Miner Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 miner-bridge.js 添加实时伴随式分析监控，订阅 ZMQ hashblock/hashtx 追踪内存池-区块差关系，SQLite 持久化，htop 风格终端仪表盘，Ctrl+C 触发 HTML 汇总报告。

**Architecture:** ZMQ 为第一数据源（维护内存池镜像，hashblock 瞬间定格快照算差集），miner-bridge 事件文件为可选增强层（提供 n/h/m 等 round 参数）。运行期间仅持久化不汇总（懒惰式），全部组件解耦，各文件单一职责。

**Tech Stack:** Node.js 18+, `zeromq`（ZMQ 客户端）, `better-sqlite3`（同步 SQLite）, `axios`（RPC，已有）, `node:test` + `node:assert`（测试）

---

## File Map

| 操作 | 路径 | 职责 |
|------|------|------|
| Create | `lib/db.js` | SQLite 封装：建表、写入、查询 |
| Create | `lib/mempool-tracker.js` | 内存池镜像：追踪入池，hashblock 时算差集 |
| Create | `lib/zmq-client.js` | ZMQ SUB 连接封装，emit hashblock/hashtx 事件 |
| Create | `lib/event-watcher.js` | 监听 miner-bridge-events.jsonl，emit 新行 |
| Create | `lib/dashboard.js` | 终端仪表盘：ANSI 覆盖渲染 |
| Create | `lib/html-report.js` | HTML 汇总报告生成（Chart.js） |
| Create | `analyzers/miner-monitor.js` | 主入口：组装所有模块，处理 SIGINT |
| Create | `tests/test-db.js` | db.js 单元测试 |
| Create | `tests/test-mempool-tracker.js` | mempool-tracker.js 单元测试 |
| Create | `tests/test-event-watcher.js` | event-watcher.js 单元测试 |
| Create | `tests/test-dashboard.js` | dashboard.js 渲染测试 |
| Modify | `../tx-height-test/miner-bridge.js` | 添加 appendEvent 工具函数 + 4 处调用 |

---

## Task 1: 安装依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 zeromq 和 better-sqlite3**

```bash
cd /home/nemo/projects/analyzer
npm install zeromq better-sqlite3
```

Expected: 两个包安装成功，`package.json` 的 dependencies 更新。若 better-sqlite3 需要编译，需有 python3 和 gcc（Ubuntu 默认有）。

- [ ] **Step 2: 创建 tests 目录**

```bash
mkdir -p tests
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "[add] zeromq and better-sqlite3 dependencies"
```

---

## Task 2: lib/db.js — SQLite 层

**Files:**
- Create: `lib/db.js`
- Create: `tests/test-db.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/test-db.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { DB } = require('../lib/db');

test('creates tables without error', () => {
    const db = new DB(':memory:');
    db.close();
});

test('insertRound returns numeric id', () => {
    const db = new DB(':memory:');
    const id = db.insertRound({
        height: 100,
        block_hash: 'abc123',
        block_time: 1000,
        detected_at: 1001,
        mempool_size_before: 500,
        mempool_size_after: 200,
        block_tx_count: 301,
        packed_from_pool: 300,
    });
    assert.strictEqual(typeof id, 'number');
    assert.ok(id > 0);
    db.close();
});

test('insertRound with MB fields', () => {
    const db = new DB(':memory:');
    const id = db.insertRound({
        height: 101,
        block_hash: 'def456',
        block_time: 2000,
        detected_at: 2001,
        mempool_size_before: 300,
        mempool_size_after: 100,
        block_tx_count: 201,
        packed_from_pool: 200,
        mb_n: 500, mb_h: 480, mb_m: 120,
        mb_gen_ms: 3000,
        mb_phase1_sent: 400, mb_phase1_ok: 395,
        mb_phase2_sent: 100, mb_phase2_ok: 98,
        mb_mine_ms: 45000,
    });
    const rows = db.getRecentRounds(5);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mb_h, 480);
    db.close();
});

test('insertMempoolTxsBatch stores rows', () => {
    const db = new DB(':memory:');
    const roundId = db.insertRound({
        height: 102, block_hash: 'fff', block_time: 0,
        detected_at: 0, mempool_size_before: 2, mempool_size_after: 1,
        block_tx_count: 2, packed_from_pool: 1,
    });
    db.insertMempoolTxsBatch(roundId, [
        { txid: 'tx1', entered_at: 100, packed: 1 },
        { txid: 'tx2', entered_at: 200, packed: 0 },
    ]);
    const txs = db.getMempoolTxs(roundId);
    assert.strictEqual(txs.length, 2);
    assert.strictEqual(txs.find(t => t.txid === 'tx1').packed, 1);
    db.close();
});

test('getStats returns correct totals', () => {
    const db = new DB(':memory:');
    db.insertRound({ height: 1, block_hash: 'a', block_time: 0, detected_at: 0,
        mempool_size_before: 1000, mempool_size_after: 100, block_tx_count: 901, packed_from_pool: 900 });
    db.insertRound({ height: 2, block_hash: 'b', block_time: 0, detected_at: 0,
        mempool_size_before: 500, mempool_size_after: 50, block_tx_count: 451, packed_from_pool: 450 });
    const stats = db.getStats();
    assert.strictEqual(stats.totalRounds, 2);
    assert.strictEqual(stats.totalPacked, 1350);
    assert.strictEqual(stats.avgMempoolBefore, 750);
    db.close();
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test tests/test-db.js
```

Expected: `Error: Cannot find module '../lib/db'`

- [ ] **Step 3: 实现 lib/db.js**

创建 `lib/db.js`：

```js
const Database = require('better-sqlite3');

class DB {
    constructor(dbPath) {
        this.sqlite = new Database(dbPath);
        this._createTables();
        this._prepareStatements();
    }

    _createTables() {
        this.sqlite.exec(`
            CREATE TABLE IF NOT EXISTS rounds (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                height              INTEGER NOT NULL,
                block_hash          TEXT NOT NULL,
                block_time          INTEGER,
                detected_at         INTEGER,
                mempool_size_before INTEGER,
                mempool_size_after  INTEGER,
                block_tx_count      INTEGER,
                packed_from_pool    INTEGER,
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
            CREATE TABLE IF NOT EXISTS mempool_txs (
                round_id    INTEGER REFERENCES rounds(id),
                txid        TEXT NOT NULL,
                entered_at  INTEGER,
                packed      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mempool_txs_round ON mempool_txs(round_id);
        `);
    }

    _prepareStatements() {
        this._insertRoundStmt = this.sqlite.prepare(`
            INSERT INTO rounds (
                height, block_hash, block_time, detected_at,
                mempool_size_before, mempool_size_after, block_tx_count, packed_from_pool,
                mb_n, mb_h, mb_m, mb_gen_ms,
                mb_phase1_sent, mb_phase1_ok, mb_phase2_sent, mb_phase2_ok, mb_mine_ms
            ) VALUES (
                @height, @block_hash, @block_time, @detected_at,
                @mempool_size_before, @mempool_size_after, @block_tx_count, @packed_from_pool,
                @mb_n, @mb_h, @mb_m, @mb_gen_ms,
                @mb_phase1_sent, @mb_phase1_ok, @mb_phase2_sent, @mb_phase2_ok, @mb_mine_ms
            )
        `);
        this._insertTxStmt = this.sqlite.prepare(`
            INSERT INTO mempool_txs (round_id, txid, entered_at, packed)
            VALUES (@round_id, @txid, @entered_at, @packed)
        `);
    }

    insertRound(data) {
        const row = {
            height: data.height, block_hash: data.block_hash,
            block_time: data.block_time ?? null, detected_at: data.detected_at ?? null,
            mempool_size_before: data.mempool_size_before ?? null,
            mempool_size_after: data.mempool_size_after ?? null,
            block_tx_count: data.block_tx_count ?? null,
            packed_from_pool: data.packed_from_pool ?? null,
            mb_n: data.mb_n ?? null, mb_h: data.mb_h ?? null, mb_m: data.mb_m ?? null,
            mb_gen_ms: data.mb_gen_ms ?? null,
            mb_phase1_sent: data.mb_phase1_sent ?? null, mb_phase1_ok: data.mb_phase1_ok ?? null,
            mb_phase2_sent: data.mb_phase2_sent ?? null, mb_phase2_ok: data.mb_phase2_ok ?? null,
            mb_mine_ms: data.mb_mine_ms ?? null,
        };
        const result = this._insertRoundStmt.run(row);
        return result.lastInsertRowid;
    }

    insertMempoolTxsBatch(roundId, txArray) {
        const insertMany = this.sqlite.transaction((txs) => {
            for (const tx of txs) {
                this._insertTxStmt.run({
                    round_id: roundId,
                    txid: tx.txid,
                    entered_at: tx.entered_at ?? null,
                    packed: tx.packed,
                });
            }
        });
        insertMany(txArray);
    }

    getRecentRounds(limit = 20) {
        return this.sqlite.prepare(
            'SELECT * FROM rounds ORDER BY id DESC LIMIT ?'
        ).all(limit).reverse();
    }

    getAllRounds() {
        return this.sqlite.prepare('SELECT * FROM rounds ORDER BY id ASC').all();
    }

    getMempoolTxs(roundId) {
        return this.sqlite.prepare(
            'SELECT * FROM mempool_txs WHERE round_id = ?'
        ).all(roundId);
    }

    getStats() {
        const row = this.sqlite.prepare(`
            SELECT
                COUNT(*)          AS totalRounds,
                SUM(packed_from_pool)         AS totalPacked,
                AVG(mempool_size_before)      AS avgMempoolBefore,
                AVG(packed_from_pool * 1.0 / NULLIF(mempool_size_before, 0)) AS avgPackRate
            FROM rounds
        `).get();
        return {
            totalRounds: row.totalRounds || 0,
            totalPacked: row.totalPacked || 0,
            avgMempoolBefore: Math.round(row.avgMempoolBefore || 0),
            avgPackRate: row.avgPackRate ? (row.avgPackRate * 100).toFixed(1) + '%' : 'N/A',
        };
    }

    close() {
        this.sqlite.close();
    }
}

module.exports = { DB };
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
node --test tests/test-db.js
```

Expected: `✔ creates tables without error`, `✔ insertRound returns numeric id` 等全部通过。

- [ ] **Step 5: Commit**

```bash
git add lib/db.js tests/test-db.js
git commit -m "[add] db.js SQLite layer with tests"
```

---

## Task 3: lib/mempool-tracker.js — 内存池镜像

**Files:**
- Create: `lib/mempool-tracker.js`
- Create: `tests/test-mempool-tracker.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/test-mempool-tracker.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { MempoolTracker } = require('../lib/mempool-tracker');

test('tracks tx entry', () => {
    const t = new MempoolTracker();
    t.onTx('tx1', 1000);
    t.onTx('tx2', 1001);
    assert.strictEqual(t.getMempoolSize(), 2);
});

test('onBlock returns correct diff', () => {
    const t = new MempoolTracker();
    t.onTx('tx1', 1000);
    t.onTx('tx2', 1001);
    t.onTx('tx3', 1002);

    // block includes tx1 and tx2 (plus coinbase which is not in mempool)
    const result = t.onBlock('hash1', ['coinbase', 'tx1', 'tx2'], 2000);

    assert.strictEqual(result.mempoolBefore, 3);
    assert.strictEqual(result.packedCount, 2);
    assert.strictEqual(result.stayedCount, 1);
    assert.ok(result.packed.has('tx1'));
    assert.ok(result.packed.has('tx2'));
    assert.ok(!result.packed.has('tx3'));
    assert.ok(result.stayed.has('tx3'));
});

test('onBlock removes packed txs from mirror', () => {
    const t = new MempoolTracker();
    t.onTx('tx1', 1000);
    t.onTx('tx2', 1001);

    t.onBlock('hash1', ['tx1'], 2000);
    assert.strictEqual(t.getMempoolSize(), 1);

    t.onBlock('hash2', ['tx2'], 3000);
    assert.strictEqual(t.getMempoolSize(), 0);
});

test('duplicate tx entry is ignored', () => {
    const t = new MempoolTracker();
    t.onTx('tx1', 1000);
    t.onTx('tx1', 1001); // duplicate
    assert.strictEqual(t.getMempoolSize(), 1);
    assert.strictEqual(t.getEnteredAt('tx1'), 1000); // keeps first
});

test('seed populates initial state', () => {
    const t = new MempoolTracker();
    t.seed([
        { txid: 'a', time: 900 },
        { txid: 'b', time: 950 },
    ]);
    assert.strictEqual(t.getMempoolSize(), 2);
});

test('onBlock mempoolAfter is correct', () => {
    const t = new MempoolTracker();
    t.onTx('tx1', 1000);
    t.onTx('tx2', 1001);
    t.onTx('tx3', 1002);
    const result = t.onBlock('hash1', ['tx1', 'tx2'], 2000);
    assert.strictEqual(result.mempoolAfter, 1);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test tests/test-mempool-tracker.js
```

Expected: `Error: Cannot find module '../lib/mempool-tracker'`

- [ ] **Step 3: 实现 lib/mempool-tracker.js**

创建 `lib/mempool-tracker.js`：

```js
class MempoolTracker {
    constructor() {
        // txid → entered_at timestamp
        this._mirror = new Map();
    }

    onTx(txid, timestamp) {
        if (!this._mirror.has(txid)) {
            this._mirror.set(txid, timestamp);
        }
    }

    /**
     * 处理新块事件。
     * @param {string} blockHash
     * @param {string[]} blockTxids - 区块内所有 txid（含 coinbase）
     * @param {number} timestamp - 收到 hashblock 的时间戳（ms）
     * @returns {{ mempoolBefore, mempoolAfter, packedCount, stayedCount, packed: Set, stayed: Map }}
     */
    onBlock(blockHash, blockTxids, timestamp) {
        const mempoolBefore = this._mirror.size;
        const blockSet = new Set(blockTxids);

        const packed = new Set();
        const stayed = new Map();

        for (const [txid, enteredAt] of this._mirror) {
            if (blockSet.has(txid)) {
                packed.add(txid);
            } else {
                stayed.set(txid, enteredAt);
            }
        }

        // 从镜像中移除已打包的交易
        for (const txid of packed) {
            this._mirror.delete(txid);
        }

        return {
            mempoolBefore,
            mempoolAfter: this._mirror.size,
            packedCount: packed.size,
            stayedCount: stayed.size,
            packed,
            stayed,
        };
    }

    /**
     * 用初始内存池数据预热镜像（启动时调用）
     * @param {{ txid: string, time: number }[]} txs
     */
    seed(txs) {
        for (const { txid, time } of txs) {
            if (!this._mirror.has(txid)) {
                this._mirror.set(txid, time);
            }
        }
    }

    getMempoolSize() {
        return this._mirror.size;
    }

    getEnteredAt(txid) {
        return this._mirror.get(txid);
    }

    getSnapshot() {
        return new Map(this._mirror);
    }
}

module.exports = { MempoolTracker };
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
node --test tests/test-mempool-tracker.js
```

Expected: 全部 6 个测试通过。

- [ ] **Step 5: Commit**

```bash
git add lib/mempool-tracker.js tests/test-mempool-tracker.js
git commit -m "[add] mempool-tracker.js with tests"
```

---

## Task 4: lib/zmq-client.js — ZMQ 封装

**Files:**
- Create: `lib/zmq-client.js`

注：ZMQ 依赖真实节点，不写自动化单元测试，靠集成测试验证。

- [ ] **Step 1: 实现 lib/zmq-client.js**

创建 `lib/zmq-client.js`：

```js
const zmq = require('zeromq');
const { EventEmitter } = require('events');

/**
 * ZMQ SUB 客户端，订阅 hashblock 和 hashtx。
 * 事件:
 *   'hashblock' (hashHex: string)
 *   'hashtx'    (hashHex: string)
 *   'error'     (err: Error)
 *   'connect'   ()
 */
class ZmqClient extends EventEmitter {
    constructor(url = 'tcp://localhost:28332') {
        super();
        this.url = url;
        this.sock = null;
        this._running = false;
    }

    async connect() {
        this.sock = new zmq.Subscriber();
        await this.sock.connect(this.url);
        this.sock.subscribe('hashblock');
        this.sock.subscribe('hashtx');
        this._running = true;
        this.emit('connect');
        this._loop();
    }

    async _loop() {
        try {
            for await (const [topic, hash] of this.sock) {
                if (!this._running) break;
                const topicStr = topic.toString();
                const hashHex = Buffer.from(hash).toString('hex');
                if (topicStr === 'hashblock' || topicStr === 'hashtx') {
                    this.emit(topicStr, hashHex);
                }
            }
        } catch (err) {
            if (this._running) {
                this.emit('error', err);
            }
        }
    }

    disconnect() {
        this._running = false;
        if (this.sock) {
            try { this.sock.close(); } catch (_) {}
            this.sock = null;
        }
    }
}

module.exports = { ZmqClient };
```

- [ ] **Step 2: Commit**

```bash
git add lib/zmq-client.js
git commit -m "[add] zmq-client.js ZMQ subscriber wrapper"
```

---

## Task 5: lib/event-watcher.js — miner-bridge 事件文件监听

**Files:**
- Create: `lib/event-watcher.js`
- Create: `tests/test-event-watcher.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/test-event-watcher.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventWatcher } = require('../lib/event-watcher');

function withTempFile(fn) {
    const p = path.join(os.tmpdir(), `ew-test-${Date.now()}.jsonl`);
    fs.writeFileSync(p, '');
    try { return fn(p); } finally {
        try { fs.unlinkSync(p); } catch (_) {}
    }
}

test('reads existing lines on start', async () => {
    await withTempFile(async (p) => {
        fs.writeFileSync(p, JSON.stringify({ type: 'round_start', height: 1 }) + '\n');
        const watcher = new EventWatcher(p);
        const events = [];
        watcher.on('event', e => events.push(e));
        await watcher.start();
        // give one tick for sync read
        await new Promise(r => setTimeout(r, 50));
        watcher.stop();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].type, 'round_start');
    });
});

test('detects appended lines', async () => {
    await withTempFile(async (p) => {
        const watcher = new EventWatcher(p);
        const events = [];
        watcher.on('event', e => events.push(e));
        await watcher.start();

        fs.appendFileSync(p, JSON.stringify({ type: 'phase1_stop', height: 2 }) + '\n');
        await new Promise(r => setTimeout(r, 200));
        watcher.stop();

        assert.ok(events.some(e => e.type === 'phase1_stop'));
    });
});

test('emits error event for invalid JSON', async () => {
    await withTempFile(async (p) => {
        const watcher = new EventWatcher(p);
        const errors = [];
        watcher.on('parse_error', e => errors.push(e));
        await watcher.start();

        fs.appendFileSync(p, 'not-valid-json\n');
        await new Promise(r => setTimeout(r, 200));
        watcher.stop();

        assert.strictEqual(errors.length, 1);
    });
});

test('stop is idempotent', async () => {
    await withTempFile(async (p) => {
        const watcher = new EventWatcher(p);
        await watcher.start();
        watcher.stop();
        watcher.stop(); // should not throw
    });
});

test('returns false for isConnected when file does not exist', () => {
    const watcher = new EventWatcher('/nonexistent/path.jsonl');
    assert.strictEqual(watcher.isConnected(), false);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test tests/test-event-watcher.js
```

Expected: `Error: Cannot find module '../lib/event-watcher'`

- [ ] **Step 3: 实现 lib/event-watcher.js**

创建 `lib/event-watcher.js`：

```js
const fs = require('fs');
const { EventEmitter } = require('events');

/**
 * 监听 miner-bridge-events.jsonl 文件的新行。
 * 事件:
 *   'event'       (parsed: object) - 新解析的 JSON 行
 *   'parse_error' (line: string)   - JSON 解析失败的行
 */
class EventWatcher extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this._offset = 0;
        this._watcher = null;
        this._connected = false;
    }

    async start() {
        if (!fs.existsSync(this.filePath)) {
            return; // 文件不存在时不启动，isConnected() 返回 false
        }
        this._connected = true;
        // 先读取已有内容
        this._readNew();
        // 再监听变化
        this._watcher = fs.watch(this.filePath, () => {
            this._readNew();
        });
    }

    _readNew() {
        let stat;
        try {
            stat = fs.statSync(this.filePath);
        } catch (_) { return; }

        if (stat.size <= this._offset) return;

        const fd = fs.openSync(this.filePath, 'r');
        const buf = Buffer.alloc(stat.size - this._offset);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, this._offset);
        fs.closeSync(fd);

        this._offset += bytesRead;
        const chunk = buf.slice(0, bytesRead).toString('utf8');
        const lines = chunk.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                this.emit('event', JSON.parse(trimmed));
            } catch (_) {
                this.emit('parse_error', trimmed);
            }
        }
    }

    stop() {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
        this._connected = false;
    }

    isConnected() {
        return this._connected;
    }
}

module.exports = { EventWatcher };
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
node --test tests/test-event-watcher.js
```

Expected: 全部 5 个测试通过。

- [ ] **Step 5: Commit**

```bash
git add lib/event-watcher.js tests/test-event-watcher.js
git commit -m "[add] event-watcher.js with tests"
```

---

## Task 6: lib/dashboard.js — 终端仪表盘

**Files:**
- Create: `lib/dashboard.js`
- Create: `tests/test-dashboard.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/test-dashboard.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { Dashboard } = require('../lib/dashboard');

const sampleState = {
    rounds: [
        { height: 100, block_hash: 'aabbccdd1122334455667788', detected_at: 1000,
          mempool_size_before: 5000, mempool_size_after: 200, packed_from_pool: 4800,
          mb_h: 500, mb_m: 120, mb_n: 500 },
        { height: 101, block_hash: 'ff00112233445566778899aa', detected_at: 2000,
          mempool_size_before: 300, mempool_size_after: 280, packed_from_pool: 20,
          mb_h: null, mb_m: null, mb_n: null },
    ],
    stats: { totalRounds: 2, totalPacked: 4820, avgMempoolBefore: 2650, avgPackRate: '91.3%' },
    zmqConnected: true,
    mbConnected: false,
    currentHeight: 101,
};

test('render returns non-empty string', () => {
    const dash = new Dashboard();
    const output = dash.render(sampleState);
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
});

test('render contains height values', () => {
    const dash = new Dashboard();
    const output = dash.render(sampleState);
    assert.ok(output.includes('100'));
    assert.ok(output.includes('101'));
});

test('render shows ZMQ connected status', () => {
    const dash = new Dashboard();
    const output = dash.render(sampleState);
    assert.ok(output.includes('ZMQ'));
});

test('render shows MB status', () => {
    const dash = new Dashboard();
    const output = dash.render(sampleState);
    assert.ok(output.includes('MB'));
});

test('render handles empty rounds', () => {
    const dash = new Dashboard();
    const output = dash.render({ rounds: [], stats: { totalRounds: 0, totalPacked: 0, avgMempoolBefore: 0, avgPackRate: 'N/A' }, zmqConnected: false, mbConnected: false, currentHeight: null });
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test tests/test-dashboard.js
```

Expected: `Error: Cannot find module '../lib/dashboard'`

- [ ] **Step 3: 实现 lib/dashboard.js**

创建 `lib/dashboard.js`：

```js
const COLS = process.stdout.columns || 80;
const SEP = '═'.repeat(Math.min(COLS, 74));
const DIV = '─'.repeat(Math.min(COLS, 74));

function pad(s, n, right = false) {
    const str = String(s ?? '');
    if (right) return str.slice(0, n).padStart(n);
    return str.slice(0, n).padEnd(n);
}

function shortHash(hash) {
    if (!hash) return '???';
    return hash.slice(0, 8) + '...' + hash.slice(-4);
}

function packRate(before, packed) {
    if (!before || before === 0) return 'N/A ';
    return ((packed / before) * 100).toFixed(0) + '%';
}

class Dashboard {
    render(state) {
        const { rounds, stats, zmqConnected, mbConnected, currentHeight } = state;
        const lines = [];

        const zmqStatus = zmqConnected ? '✓ 已连接' : '✗ 未连接';
        const mbStatus  = mbConnected  ? '✓ 已连接' : '✗ 未连接';

        lines.push(SEP);
        lines.push(` Miner Monitor  ZMQ: ${zmqStatus}   MB事件: ${mbStatus}   当前高度: ${currentHeight ?? '—'}`);
        lines.push(DIV);
        lines.push(` ${pad('高度', 7)} ${pad('区块哈希', 16)} ${pad('池前', 7)} ${pad('池后', 7)} ${pad('打包', 7)} ${pad('打包率', 6)} ${pad('h', 5)} ${pad('m', 5)}`);
        lines.push(DIV);

        const displayRounds = rounds.slice(-15);
        for (const r of displayRounds) {
            const mode = (r.mb_h != null) ? '' : ' *';
            lines.push(
                ` ${pad(r.height, 7)} ${pad(shortHash(r.block_hash), 16)} ` +
                `${pad(r.mempool_size_before, 7)} ${pad(r.mempool_size_after, 7)} ` +
                `${pad(r.packed_from_pool, 7)} ${pad(packRate(r.mempool_size_before, r.packed_from_pool), 6)} ` +
                `${pad(r.mb_h ?? '-', 5)} ${pad(r.mb_m ?? '-', 5)}${mode}`
            );
        }

        if (displayRounds.length === 0) {
            lines.push('  （等待第一个区块...）');
        }

        lines.push(DIV);
        lines.push(
            ` 轮数: ${stats.totalRounds}   ` +
            `总打包: ${stats.totalPacked}   ` +
            `均值池大小: ${stats.avgMempoolBefore}   ` +
            `均值打包率: ${stats.avgPackRate}`
        );
        lines.push(` * = 仅 ZMQ 模式（无 MB 事件）`);
        lines.push(SEP);
        lines.push(' [Ctrl+C] 退出并生成 HTML 汇总报告');

        return lines.join('\n');
    }

    draw(state) {
        const output = this.render(state);
        process.stdout.write('\x1b[2J\x1b[H' + output + '\n');
    }
}

module.exports = { Dashboard };
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
node --test tests/test-dashboard.js
```

Expected: 全部 5 个测试通过。

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard.js tests/test-dashboard.js
git commit -m "[add] dashboard.js terminal renderer with tests"
```

---

## Task 7: lib/html-report.js — HTML 汇总报告

**Files:**
- Create: `lib/html-report.js`

- [ ] **Step 1: 实现 lib/html-report.js**

创建 `lib/html-report.js`：

```js
const fs = require('fs');
const path = require('path');

function generateHtmlReport(db, outputDir = './reports') {
    const rounds = db.getAllRounds();
    const stats  = db.getStats();

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const labels       = JSON.stringify(rounds.map(r => r.height));
    const packedData   = JSON.stringify(rounds.map(r => r.packed_from_pool ?? 0));
    const poolBefore   = JSON.stringify(rounds.map(r => r.mempool_size_before ?? 0));
    const poolAfter    = JSON.stringify(rounds.map(r => r.mempool_size_after ?? 0));
    const hData        = JSON.stringify(rounds.map(r => r.mb_h ?? null));
    const mData        = JSON.stringify(rounds.map(r => r.mb_m ?? null));
    const genMsData    = JSON.stringify(rounds.map(r => r.mb_gen_ms ?? null));
    const mineMsData   = JSON.stringify(rounds.map(r => r.mb_mine_ms ?? null));

    const mbRounds     = rounds.filter(r => r.mb_h != null);
    const hasMb        = mbRounds.length > 0;

    const tableRows = rounds.slice(-50).reverse().map(r => `
        <tr>
            <td>${r.height}</td>
            <td><code>${(r.block_hash || '').slice(0, 16)}...</code></td>
            <td>${r.mempool_size_before ?? '-'}</td>
            <td>${r.mempool_size_after ?? '-'}</td>
            <td>${r.packed_from_pool ?? '-'}</td>
            <td>${r.mb_n ?? '-'}</td>
            <td>${r.mb_h ?? '-'}</td>
            <td>${r.mb_m ?? '-'}</td>
            <td>${r.mb_gen_ms != null ? (r.mb_gen_ms / 1000).toFixed(1) + 's' : '-'}</td>
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
        <h2>每轮打包数量 & 内存池大小趋势</h2>
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
                { type: 'line', label: '打包数', data: ${packedData}, borderColor: '#0f3460', backgroundColor: 'rgba(15,52,96,0.1)', yAxisID: 'y', tension: 0.3, pointRadius: 2 },
                { type: 'line', label: '池前大小', data: ${poolBefore}, borderColor: '#e94560', backgroundColor: 'rgba(233,69,96,0.05)', yAxisID: 'y', tension: 0.3, pointRadius: 2, borderDash: [4,2] },
                { type: 'line', label: '池后大小', data: ${poolAfter}, borderColor: '#aaa', backgroundColor: 'transparent', yAxisID: 'y', tension: 0.3, pointRadius: 0, borderDash: [2,2] },
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
                { type: 'line', label: '截取点 m', data: ${mData}, borderColor: '#f5a623', tension: 0.3, pointRadius: 2 },
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
                { type: 'bar', label: '生成耗时(s)', data: ${genMsData}.map(v => v != null ? v/1000 : null), backgroundColor: 'rgba(15,52,96,0.6)', yAxisID: 'y' },
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
```

- [ ] **Step 2: Commit**

```bash
git add lib/html-report.js
git commit -m "[add] html-report.js Chart.js summary report generator"
```

---

## Task 8: analyzers/miner-monitor.js — 主入口

**Files:**
- Create: `analyzers/miner-monitor.js`

- [ ] **Step 1: 实现 analyzers/miner-monitor.js**

创建 `analyzers/miner-monitor.js`：

```js
#!/usr/bin/env node
'use strict';

const path    = require('path');
const { DB }             = require('../lib/db');
const { MempoolTracker } = require('../lib/mempool-tracker');
const { ZmqClient }      = require('../lib/zmq-client');
const { EventWatcher }   = require('../lib/event-watcher');
const { Dashboard }      = require('../lib/dashboard');
const { generateHtmlReport } = require('../lib/html-report');
const { RPCClient }      = require('../lib/rpc');

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        zmqUrl:    'tcp://localhost:28332',
        rpcUrl:    process.env.RPC_URL    || 'http://localhost:8332',
        rpcUser:   process.env.RPC_USER   || 'username',
        rpcPass:   process.env.RPC_PASS   || 'randompasswd',
        eventsFile: path.resolve(__dirname, '../../tx-height-test/miner-bridge-events.jsonl'),
        dbPath:    path.resolve(__dirname, '../reports/miner-monitor.db'),
        outputDir: path.resolve(__dirname, '../reports'),
        dashInterval: 500,
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--zmq':         cfg.zmqUrl     = args[++i]; break;
            case '--events':      cfg.eventsFile = args[++i]; break;
            case '--db':          cfg.dbPath     = args[++i]; break;
            case '--output-dir':  cfg.outputDir  = args[++i]; break;
            case '--rpc-url':     cfg.rpcUrl     = args[++i]; break;
            case '--rpc-user':    cfg.rpcUser    = args[++i]; break;
            case '--rpc-pass':    cfg.rpcPass    = args[++i]; break;
        }
    }
    return cfg;
}

// ── 主程序 ────────────────────────────────────────────────
async function main() {
    const cfg = parseArgs();

    // 确保 reports 目录存在
    const fs = require('fs');
    if (!fs.existsSync(cfg.outputDir)) fs.mkdirSync(cfg.outputDir, { recursive: true });

    const db      = new DB(cfg.dbPath);
    const tracker = new MempoolTracker();
    const rpc     = new RPCClient({ url: cfg.rpcUrl, username: cfg.rpcUser, password: cfg.rpcPass });
    const zmq     = new ZmqClient(cfg.zmqUrl);
    const watcher = new EventWatcher(cfg.eventsFile);
    const dash    = new Dashboard();

    // ── 状态 ─────────────────────────────────────────────
    let currentHeight    = null;
    let pendingRoundData = {}; // 从 miner-bridge 事件文件收集的当前轮数据
    const recentRounds   = db.getRecentRounds(15);

    function getState() {
        return {
            rounds:       recentRounds,
            stats:        db.getStats(),
            zmqConnected: zmq.listenerCount('hashblock') > 0 || true,
            mbConnected:  watcher.isConnected(),
            currentHeight,
        };
    }

    // ── ZMQ 事件 ─────────────────────────────────────────
    zmq.on('hashtx', (txid) => {
        tracker.onTx(txid, Date.now());
    });

    zmq.on('hashblock', async (blockHash) => {
        const detectedAt = Date.now();
        let block, diffResult;

        try {
            block = await rpc.call('getblock', [blockHash, 1]);
        } catch (err) {
            process.stderr.write(`[ZMQ] getblock failed: ${err.message}\n`);
            return;
        }

        const blockTxids = block.tx || [];
        diffResult = tracker.onBlock(blockHash, blockTxids, detectedAt);
        currentHeight = block.height;

        // 组装 round 数据（合并 miner-bridge 事件，若有）
        const mbData = pendingRoundData[block.height] || {};
        const roundRow = {
            height:              block.height,
            block_hash:          blockHash,
            block_time:          block.time,
            detected_at:         detectedAt,
            mempool_size_before: diffResult.mempoolBefore,
            mempool_size_after:  diffResult.mempoolAfter,
            block_tx_count:      blockTxids.length,
            packed_from_pool:    diffResult.packedCount,
            ...mbData,
        };

        const roundId = db.insertRound(roundRow);

        // 批量写入内存池 tx 记录
        const txRows = [];
        for (const txid of diffResult.packed) {
            txRows.push({ txid, entered_at: tracker.getEnteredAt(txid) ?? null, packed: 1 });
        }
        for (const [txid, enteredAt] of diffResult.stayed) {
            txRows.push({ txid, entered_at: enteredAt, packed: 0 });
        }
        if (txRows.length > 0) db.insertMempoolTxsBatch(roundId, txRows);

        // 更新仪表盘数据
        recentRounds.push({ ...roundRow, id: roundId });
        if (recentRounds.length > 15) recentRounds.shift();

        // 清理已用的 miner-bridge 数据
        delete pendingRoundData[block.height];
    });

    // ── miner-bridge 事件文件 ─────────────────────────────
    watcher.on('event', (evt) => {
        if (!evt.height) return;
        if (!pendingRoundData[evt.height]) pendingRoundData[evt.height] = {};
        const d = pendingRoundData[evt.height];

        switch (evt.type) {
            case 'round_start':
                d._start_ts = evt.ts;
                break;
            case 'phase1_stop':
                d.mb_n           = evt.n;
                d.mb_h           = evt.h;
                d.mb_m           = evt.m;
                d.mb_phase1_sent = evt.sent;
                d.mb_phase1_ok   = evt.ok;
                if (d._start_ts) d.mb_gen_ms = evt.ts - d._start_ts;
                break;
            case 'phase2_done':
                d.mb_phase2_sent = evt.sent;
                d.mb_phase2_ok   = evt.ok;
                break;
            case 'block_mined':
                if (d._start_ts) d.mb_mine_ms = evt.ts - d._start_ts;
                break;
        }
    });

    // ── 预热内存池镜像 ────────────────────────────────────
    try {
        const rawPool = await rpc.call('getrawmempool', [true]);
        const seedTxs = Object.entries(rawPool).map(([txid, info]) => ({
            txid,
            time: (info.time || 0) * 1000,
        }));
        tracker.seed(seedTxs);
    } catch (err) {
        process.stderr.write(`[init] getrawmempool failed (ok): ${err.message}\n`);
    }

    // ── 启动 ─────────────────────────────────────────────
    await watcher.start();
    await zmq.connect();

    // 仪表盘刷新
    const dashTimer = setInterval(() => {
        dash.draw(getState());
    }, cfg.dashInterval);
    dash.draw(getState());

    // ── 退出处理 ─────────────────────────────────────────
    async function shutdown() {
        clearInterval(dashTimer);
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write('正在生成 HTML 汇总报告...\n');
        try {
            const reportPath = generateHtmlReport(db, cfg.outputDir);
            process.stdout.write(`报告已保存: ${reportPath}\n`);
        } catch (err) {
            process.stderr.write(`报告生成失败: ${err.message}\n`);
        }
        zmq.disconnect();
        watcher.stop();
        db.close();
        process.exit(0);
    }

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    process.stderr.write(`[FATAL] ${err.stack}\n`);
    process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add analyzers/miner-monitor.js
git commit -m "[add] miner-monitor.js main entry point"
```

---

## Task 9: 修改 miner-bridge.js

**Files:**
- Modify: `../tx-height-test/miner-bridge.js`

在 miner-bridge.js 中添加 `appendEvent` 工具函数，并在 4 个关键点调用。

- [ ] **Step 1: 在 miner-bridge.js 顶部（`// RPC 配置` 注释之前）添加 appendEvent 工具函数**

在文件第 1 行后、`// ========================` 分隔符之前插入：

```js
// ========================
// 事件上报（供外部分析器订阅）
// ========================
const EVENTS_FILE = './miner-bridge-events.jsonl';
function appendEvent(obj) {
    try {
        fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
    } catch (_) {}
}
```

- [ ] **Step 2: 在 main() 中新块检测处（`console.log('\n[新区块]...')` 之后）添加 round_start 事件**

找到（约第 421 行）：
```js
        console.log(`\n[新区块] ${lastHeight} -> ${height}`);
        lastHeight = height;
```

在 `lastHeight = height;` 之后添加：
```js
        appendEvent({ type: 'round_start', height });
```

- [ ] **Step 3: 在 broadcastTransactions 中阶段1停止处添加 phase1_stop 事件**

找到（约第 251 行）：
```js
                console.log(`\n[阶段1停止] tx=${txId.substring(0, 16)}... depth=${node.depth} maxDesc=${maxDesc.get(txId)} 链剩余=${m}层 已广播=${sent}`);
                break;
```

在 `break;` 之前添加：
```js
                appendEvent({ type: 'phase1_stop', height: parseInt(path.basename(path.dirname(txFile))), n: order.length, h, m, sent, ok: success, fail: failed });
```

注意：broadcastTransactions 不直接接收 height，需改函数签名传入。将调用处 `broadcastTransactions(txFile, graphFile, h, m)` 改为 `broadcastTransactions(txFile, graphFile, h, m, height)`，并在函数定义中加 `height` 参数：

```js
async function broadcastTransactions(txFile, graphFile, h, m, height) {
```

然后 phase1_stop 事件中直接用 `height`：
```js
                appendEvent({ type: 'phase1_stop', height, n: order.length, h, m, sent, ok: success, fail: failed });
```

- [ ] **Step 4: 在 broadcastTransactions 阶段2完成后（第二个 `process.stdout.write('\n');` 之后，`const totalTime` 之前）添加 phase2_done 事件**

```js
    appendEvent({ type: 'phase2_done', height, total_sent: sent, total_ok: success, total_fail: failed });
```

- [ ] **Step 5: 在 mineWithTemplate 中出块确认后添加 block_mined 事件**

找到（约第 368 行）：
```js
            if (h > preMineHeight) {
                console.log(`[出块确认] 新高度 ${h}，submitblock 结果:`, submitResult);
                mined = true;
            }
```

注意此处的 `h` 是局部变量（loop 里的 `getHeight()` 结果），与外层 `h`（最大深度）同名。改为：

```js
            const newHeight = await getHeight();
            if (newHeight > preMineHeight) {
                console.log(`[出块确认] 新高度 ${newHeight}，submitblock 结果:`, submitResult);
                mined = true;
                appendEvent({ type: 'block_mined', height: preMineHeight + 1, new_height: newHeight });
            }
```

并删除原来的 `const h = await getHeight();` 行（把原循环体中的 `h` 替换为 `newHeight`）。

- [ ] **Step 6: 在 tx-height-test 目录提交**

```bash
cd /home/nemo/projects/tx-height-test
git add miner-bridge.js
git commit -m "[modify] add appendEvent for miner-monitor integration"
cd /home/nemo/projects/analyzer
```

---

## Task 10: 全量测试 + 验证

**Files:** 无新文件

- [ ] **Step 1: 运行全部单元测试**

```bash
cd /home/nemo/projects/analyzer
node --test tests/test-db.js tests/test-mempool-tracker.js tests/test-event-watcher.js tests/test-dashboard.js
```

Expected: 全部测试通过，无 FAIL。

- [ ] **Step 2: 冒烟测试 miner-monitor.js 语法**

```bash
node --check analyzers/miner-monitor.js
node --check lib/zmq-client.js
node --check lib/html-report.js
```

Expected: 无语法错误输出。

- [ ] **Step 3: 验证 miner-bridge.js 语法**

```bash
node --check /home/nemo/projects/tx-height-test/miner-bridge.js
```

Expected: 无输出（无语法错误）。

- [ ] **Step 4: 打印帮助信息验证参数解析**

```bash
node analyzers/miner-monitor.js --help 2>/dev/null || node -e "
const m = require('./analyzers/miner-monitor.js');
" 2>&1 | head -5
```

Expected: 程序尝试连接（连接失败是正常的，说明主流程可运行）。

- [ ] **Step 5: 最终 commit**

```bash
git add .
git commit -m "[add] miner-monitor complete implementation"
```

---

## 运行方式

```bash
# 在 analyzer 目录启动监控（miner-bridge 同时在另一终端运行）
node analyzers/miner-monitor.js

# 指定自定义路径
node analyzers/miner-monitor.js \
  --zmq tcp://localhost:28332 \
  --events /path/to/miner-bridge-events.jsonl \
  --db ./reports/session-1.db

# Ctrl+C 退出时自动生成 HTML 报告
```
