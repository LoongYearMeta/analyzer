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
    t.onTx('tx1', 1001);
    assert.strictEqual(t.getMempoolSize(), 1);
    assert.strictEqual(t.getEnteredAt('tx1'), 1000);
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
