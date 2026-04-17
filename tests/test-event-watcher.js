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

test('emits parse_error for invalid JSON', async () => {
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
        watcher.stop();
    });
});

test('returns false for isConnected when file does not exist', () => {
    const watcher = new EventWatcher('/nonexistent/path.jsonl');
    assert.strictEqual(watcher.isConnected(), false);
});
