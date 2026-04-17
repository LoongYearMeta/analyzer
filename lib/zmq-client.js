const zmq = require('zeromq');
const { EventEmitter } = require('events');

/**
 * ZMQ SUB 客户端，订阅 hashblock 和 hashtx。
 *
 * 事件:
 *   'hashblock' (hashHex: string)
 *   'hashtx'    (hashHex: string)
 *   'error'     (err: Error)
 *   'connect'   ()
 */
class ZmqClient extends EventEmitter {
    constructor(url = 'tcp://localhost:28332') {
        super();
        this.url = url;
        this.sock = null;
        this._running = false;
    }

    async connect() {
        this.sock = new zmq.Subscriber();
        await this.sock.connect(this.url);
        this.sock.subscribe('hashblock');
        this.sock.subscribe('hashtx');
        this._running = true;
        this.emit('connect');
        this._loop();
    }

    async _loop() {
        try {
            for await (const [topic, hash] of this.sock) {
                if (!this._running) break;
                const topicStr = topic.toString();
                const hashHex  = Buffer.from(hash).toString('hex');
                if (topicStr === 'hashblock' || topicStr === 'hashtx') {
                    this.emit(topicStr, hashHex);
                }
            }
        } catch (err) {
            if (this._running) {
                this.emit('error', err);
            }
        }
    }

    disconnect() {
        this._running = false;
        if (this.sock) {
            try { this.sock.close(); } catch (_) {}
            this.sock = null;
        }
    }
}

module.exports = { ZmqClient };
