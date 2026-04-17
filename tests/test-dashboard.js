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

test('render shows ZMQ status', () => {
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
    const output = dash.render({
        rounds: [],
        stats: { totalRounds: 0, totalPacked: 0, avgMempoolBefore: 0, avgPackRate: 'N/A' },
        zmqConnected: false,
        mbConnected: false,
        currentHeight: null,
    });
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
});
