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
        try {
            const res = await axios.post(this.url, {
                jsonrpc: '1.0',
                id: 'chain-analyzer',
                method,
                params
            }, {
                auth: this.auth,
                timeout: timeout || this.timeout
            });

            if (res.data.error) throw res.data.error;
            return res.data.result;
        } catch (err) {
            throw new Error(`RPC [${method}] failed: ${err.message}`);
        }
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
