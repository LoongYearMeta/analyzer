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
