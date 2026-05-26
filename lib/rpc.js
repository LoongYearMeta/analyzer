/**
 * RPC 基础模块
 * 为所有分析器提供统一的比特币 RPC 调用能力
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// 自动加载项目根目录的 .env 文件（无需 dotenv 依赖）
(function loadDotEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
    }
})();

class RPCClient {
    constructor(config = {}) {
        this.url = config.url || process.env.RPC_URL || 'http://localhost:8332';
        this.auth = {
            username: config.username || process.env.RPC_USER || 'username',
            password: config.password || process.env.RPC_PASS || 'randompasswd'
        };
        this.timeout = config.timeout || 30000;

        // 缓存
        this.blockCache = new Map();
        this.txCache = new Map();
        this.cacheEnabled = config.cache !== false;
    }

    async call(method, params = [], timeout = null) {
        let res;
        try {
            res = await axios.post(this.url, {
                jsonrpc: '1.0',
                id: 'chain-analyzer',
                method,
                params
            }, {
                auth: this.auth,
                timeout: timeout || this.timeout,
                validateStatus: () => true,   // 不让 axios 因 HTTP 4xx/5xx 抛异常
            });
        } catch (err) {
            throw new Error(`RPC [${method}] failed: ${err.message}`);
        }

        if (res.data?.error) {
            const msg = res.data.error.message || JSON.stringify(res.data.error);
            const err = new Error(`RPC [${method}] failed: ${msg}`);
            err.rpcCode = res.data.error.code;
            err.rpcMessage = msg;
            throw err;
        }
        return res.data.result;
    }

    async getBlockCount() {
        return this.call('getblockcount');
    }

    async getBlockHash(height) {
        return this.call('getblockhash', [height]);
    }

    async getBlock(heightOrHash, verbosity = 1) {
        const cacheKey = `${heightOrHash}_${verbosity}`;
        if (this.cacheEnabled && this.blockCache.has(cacheKey)) {
            return this.blockCache.get(cacheKey);
        }

        let hash = heightOrHash;
        if (typeof heightOrHash === 'number') {
            hash = await this.getBlockHash(heightOrHash);
        }

        const block = await this.call('getblock', [hash, verbosity]);

        if (this.cacheEnabled) {
            this.blockCache.set(cacheKey, block);
            // 同时缓存高度版本
            if (block.height !== undefined) {
                this.blockCache.set(`${block.height}_${verbosity}`, block);
            }
        }

        return block;
    }

    // getblockheader 对剪枝块也可用（不含 tx/size），用于只需要区块头字段的场景
    async getBlockHeader(heightOrHash) {
        const cacheKey = `hdr_${heightOrHash}`;
        if (this.cacheEnabled && this.blockCache.has(cacheKey)) {
            return this.blockCache.get(cacheKey);
        }

        let hash = heightOrHash;
        if (typeof heightOrHash === 'number') {
            hash = await this.getBlockHash(heightOrHash);
        }

        const hdr = await this.call('getblockheader', [hash, true]);

        if (this.cacheEnabled) {
            this.blockCache.set(cacheKey, hdr);
            if (hdr.height !== undefined) {
                this.blockCache.set(`hdr_${hdr.height}`, hdr);
            }
        }

        return hdr;
    }

    // 优先用 getblock，对剪枝块（Block not found on disk）自动回退到 getblockheader
    async getBlockOrHeader(heightOrHash) {
        try {
            return await this.getBlock(heightOrHash, 1);
        } catch (e) {
            const msg = e.rpcMessage || e.message || '';
            if (msg.includes('Block not found on disk') || msg.includes('pruned')) {
                return await this.getBlockHeader(heightOrHash);
            }
            throw e;
        }
    }

    async getRawTransaction(txid, blockHash = null) {
        if (this.cacheEnabled && this.txCache.has(txid)) {
            return this.txCache.get(txid);
        }

        try {
            const params = blockHash ? [txid, true, blockHash] : [txid, true];
            const tx = await this.call('getrawtransaction', params);

            if (this.cacheEnabled) {
                this.txCache.set(txid, tx);
            }

            return tx;
        } catch (err) {
            return null;
        }
    }

    clearCache() {
        this.blockCache.clear();
        this.txCache.clear();
    }

    getCacheStats() {
        return {
            blocks: this.blockCache.size,
            transactions: this.txCache.size
        };
    }
}

module.exports = { RPCClient };
