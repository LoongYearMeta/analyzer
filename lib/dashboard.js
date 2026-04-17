const COLS = process.stdout.columns || 80;
const W    = Math.min(COLS, 76);
const SEP  = '═'.repeat(W);
const DIV  = '─'.repeat(W);

function pad(s, n, right = false) {
    const str = String(s ?? '');
    if (right) return str.slice(0, n).padStart(n);
    return str.slice(0, n).padEnd(n);
}

function shortHash(hash) {
    if (!hash) return '???';
    return hash.slice(0, 8) + '..' + hash.slice(-4);
}

function packRate(before, packed) {
    if (!before || before === 0) return 'N/A ';
    return ((packed / before) * 100).toFixed(0) + '%';
}

class Dashboard {
    render(state) {
        const { rounds, stats, zmqConnected, mbConnected, currentHeight } = state;
        const lines = [];

        const zmqStr = zmqConnected ? '✓连接' : '✗断开';
        const mbStr  = mbConnected  ? '✓连接' : '✗断开';

        lines.push(SEP);
        lines.push(` Miner Monitor   ZMQ:${zmqStr}   MB事件:${mbStr}   高度:${currentHeight ?? '—'}`);
        lines.push(DIV);
        lines.push(` ${'高度'.padEnd(7)} ${'区块哈希'.padEnd(14)} ${'池前'.padEnd(7)} ${'池后'.padEnd(7)} ${'打包'.padEnd(7)} ${'打包率'.padEnd(6)} ${'h'.padEnd(6)} ${'m'.padEnd(5)}`);
        lines.push(DIV);

        const displayRounds = rounds.slice(-15);
        for (const r of displayRounds) {
            const star = (r.mb_h != null) ? ' ' : '*';
            lines.push(
                `${star}${pad(r.height, 6)} ${pad(shortHash(r.block_hash), 14)} ` +
                `${pad(r.mempool_size_before, 7)} ${pad(r.mempool_size_after, 7)} ` +
                `${pad(r.packed_from_pool, 7)} ${pad(packRate(r.mempool_size_before, r.packed_from_pool), 6)} ` +
                `${pad(r.mb_h ?? '-', 6)} ${pad(r.mb_m ?? '-', 5)}`
            );
        }

        if (displayRounds.length === 0) {
            lines.push('  （等待第一个区块...）');
        }

        lines.push(DIV);
        lines.push(
            ` 轮数:${stats.totalRounds}  总打包:${stats.totalPacked}  ` +
            `均值池:${stats.avgMempoolBefore}  均值打包率:${stats.avgPackRate}`
        );
        lines.push(` * = 纯ZMQ模式（无MB事件增强）`);
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
