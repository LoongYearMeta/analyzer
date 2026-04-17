const fs = require('fs');
const { EventEmitter } = require('events');

/**
 * 监听 miner-bridge-events.jsonl 文件的新增行。
 *
 * 事件:
 *   'event'       (parsed: object) - 新解析的 JSON 行
 *   'parse_error' (line: string)   - JSON 解析失败的行
 */
class EventWatcher extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath  = filePath;
        this._offset   = 0;
        this._watcher  = null;
        this._connected = false;
    }

    async start() {
        if (!fs.existsSync(this.filePath)) {
            return;
        }
        this._connected = true;
        this._readNew();
        this._watcher = fs.watch(this.filePath, () => {
            this._readNew();
        });
    }

    _readNew() {
        let stat;
        try {
            stat = fs.statSync(this.filePath);
        } catch (_) { return; }

        if (stat.size <= this._offset) return;

        const fd  = fs.openSync(this.filePath, 'r');
        const buf = Buffer.alloc(stat.size - this._offset);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, this._offset);
        fs.closeSync(fd);

        this._offset += bytesRead;
        const chunk = buf.slice(0, bytesRead).toString('utf8');

        for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                this.emit('event', JSON.parse(trimmed));
            } catch (_) {
                this.emit('parse_error', trimmed);
            }
        }
    }

    stop() {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
        this._connected = false;
    }

    isConnected() {
        return this._connected;
    }
}

module.exports = { EventWatcher };
