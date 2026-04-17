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
                COUNT(*)                                                          AS totalRounds,
                SUM(packed_from_pool)                                             AS totalPacked,
                AVG(mempool_size_before)                                          AS avgMempoolBefore,
                AVG(packed_from_pool * 1.0 / NULLIF(mempool_size_before, 0))     AS avgPackRate
            FROM rounds
        `).get();
        return {
            totalRounds:     row.totalRounds || 0,
            totalPacked:     row.totalPacked || 0,
            avgMempoolBefore: Math.round(row.avgMempoolBefore || 0),
            avgPackRate:     row.avgPackRate ? (row.avgPackRate * 100).toFixed(1) + '%' : 'N/A',
        };
    }

    close() {
        this.sqlite.close();
    }
}

module.exports = { DB };
