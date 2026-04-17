class MempoolTracker {
    constructor() {
        this._mirror = new Map(); // txid → entered_at timestamp
    }

    onTx(txid, timestamp) {
        if (!this._mirror.has(txid)) {
            this._mirror.set(txid, timestamp);
        }
    }

    /**
     * 处理新块事件，计算内存池差集。
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

        for (const txid of packed) {
            this._mirror.delete(txid);
        }

        return {
            mempoolBefore,
            mempoolAfter: this._mirror.size,
            packedCount:  packed.size,
            stayedCount:  stayed.size,
            packed,
            stayed,
        };
    }

    /**
     * 用初始内存池数据预热镜像（启动时调用一次）。
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
