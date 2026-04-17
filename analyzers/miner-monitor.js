#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const { DB }                 = require('../lib/db');
const { MempoolTracker }     = require('../lib/mempool-tracker');
const { ZmqClient }          = require('../lib/zmq-client');
const { EventWatcher }       = require('../lib/event-watcher');
const { Dashboard }          = require('../lib/dashboard');
const { generateHtmlReport } = require('../lib/html-report');
const { RPCClient }          = require('../lib/rpc');

// ── 参数解析 ──────────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        zmqUrl:      'tcp://localhost:28332',
        rpcUrl:      process.env.RPC_URL  || 'http://localhost:8332',
        rpcUser:     process.env.RPC_USER || 'username',
        rpcPass:     process.env.RPC_PASS || 'randompasswd',
        eventsFile:  path.resolve(__dirname, '../../tx-height-test/miner-bridge-events.jsonl'),
        dbPath:      path.resolve(__dirname, '../reports/miner-monitor.db'),
        outputDir:   path.resolve(__dirname, '../reports'),
        dashInterval: 500,
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--zmq':         cfg.zmqUrl     = args[++i]; break;
            case '--events':      cfg.eventsFile = path.resolve(args[++i]); break;
            case '--db':          cfg.dbPath     = path.resolve(args[++i]); break;
            case '--output-dir':  cfg.outputDir  = path.resolve(args[++i]); break;
            case '--rpc-url':     cfg.rpcUrl     = args[++i]; break;
            case '--rpc-user':    cfg.rpcUser    = args[++i]; break;
            case '--rpc-pass':    cfg.rpcPass    = args[++i]; break;
        }
    }
    return cfg;
}

// ── 主程序 ────────────────────────────────────────────────────────────────────
async function main() {
    const cfg = parseArgs();

    if (!fs.existsSync(cfg.outputDir)) fs.mkdirSync(cfg.outputDir, { recursive: true });

    const db      = new DB(cfg.dbPath);
    const tracker = new MempoolTracker();
    const rpc     = new RPCClient({ url: cfg.rpcUrl, username: cfg.rpcUser, password: cfg.rpcPass });
    const zmq     = new ZmqClient(cfg.zmqUrl);
    const watcher = new EventWatcher(cfg.eventsFile);
    const dash    = new Dashboard();

    // ── 状态 ─────────────────────────────────────────────────────────────────
    let currentHeight    = null;
    const pendingMb      = {}; // height → partial MB event data
    const recentRounds   = db.getRecentRounds(15);

    function getState() {
        return {
            rounds:       recentRounds,
            stats:        db.getStats(),
            zmqConnected: true,
            mbConnected:  watcher.isConnected(),
            currentHeight,
        };
    }

    // ── ZMQ: 追踪入池交易 ────────────────────────────────────────────────────
    zmq.on('hashtx', (txid) => {
        tracker.onTx(txid, Date.now());
    });

    // ── ZMQ: 新块 ────────────────────────────────────────────────────────────
    zmq.on('hashblock', async (blockHash) => {
        const detectedAt = Date.now();
        let block;

        try {
            block = await rpc.call('getblock', [blockHash, 1]);
        } catch (err) {
            process.stderr.write(`[ZMQ] getblock failed: ${err.message}\n`);
            return;
        }

        const blockTxids = block.tx || [];
        const diff = tracker.onBlock(blockHash, blockTxids, detectedAt);
        currentHeight = block.height;

        const mbData = pendingMb[block.height] || {};
        const roundRow = {
            height:              block.height,
            block_hash:          blockHash,
            block_time:          block.time,
            detected_at:         detectedAt,
            mempool_size_before: diff.mempoolBefore,
            mempool_size_after:  diff.mempoolAfter,
            block_tx_count:      blockTxids.length,
            packed_from_pool:    diff.packedCount,
            ...mbData,
        };

        const roundId = db.insertRound(roundRow);

        // 批量写入内存池 tx 快照
        const txRows = [];
        for (const txid of diff.packed) {
            txRows.push({ txid, entered_at: tracker.getEnteredAt(txid) ?? null, packed: 1 });
        }
        for (const [txid, enteredAt] of diff.stayed) {
            txRows.push({ txid, entered_at: enteredAt, packed: 0 });
        }
        if (txRows.length > 0) db.insertMempoolTxsBatch(roundId, txRows);

        recentRounds.push({ ...roundRow, id: roundId });
        if (recentRounds.length > 15) recentRounds.shift();

        delete pendingMb[block.height];
    });

    zmq.on('error', (err) => {
        process.stderr.write(`[ZMQ] error: ${err.message}\n`);
    });

    // ── miner-bridge 事件文件（可选增强） ─────────────────────────────────────
    watcher.on('event', (evt) => {
        if (!evt.height) return;
        if (!pendingMb[evt.height]) pendingMb[evt.height] = {};
        const d = pendingMb[evt.height];

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
                d.mb_phase2_sent = evt.total_sent;
                d.mb_phase2_ok   = evt.total_ok;
                break;
            case 'block_mined':
                if (d._start_ts) d.mb_mine_ms = evt.ts - d._start_ts;
                break;
        }
    });

    // ── 预热内存池镜像 ────────────────────────────────────────────────────────
    try {
        const rawPool = await rpc.call('getrawmempool', [true]);
        const seedTxs = Object.entries(rawPool).map(([txid, info]) => ({
            txid,
            time: (info.time || 0) * 1000,
        }));
        tracker.seed(seedTxs);
        process.stderr.write(`[init] 内存池预热: ${seedTxs.length} 笔交易\n`);
    } catch (err) {
        process.stderr.write(`[init] getrawmempool 失败（忽略）: ${err.message}\n`);
    }

    // ── 启动 ─────────────────────────────────────────────────────────────────
    await watcher.start();
    await zmq.connect();

    const dashTimer = setInterval(() => dash.draw(getState()), cfg.dashInterval);
    dash.draw(getState());

    // ── SIGINT / SIGTERM 退出 ────────────────────────────────────────────────
    async function shutdown() {
        clearInterval(dashTimer);
        process.stdout.write('\x1b[2J\x1b[H正在生成 HTML 汇总报告...\n');
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
