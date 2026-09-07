const http = require('http');
const logger = require('../utils/logger');
const metrics = require('../metrics');

let server = null;
let tokenExpiry = null;
let wsInstance = null;

module.exports = {
    incRestart() {
        try {
            const counter = metrics.register.getSingleMetric('maidbot_pm2_restarts');
            if (counter && typeof counter.inc === 'function') counter.inc();
        } catch (_) {}
    },

    messageReceived(type) {
        try {
            metrics.msg(type || 'unknown');
        } catch (_) {}
    },

    // ⭐ 关键：心跳函数，在收到心跳ACK时调用
    heartbeat() {
        try {
            // 可以在这里更新一个“最后心跳时间”的指标
            // 目前先留空，防止程序崩溃即可
        } catch (_) {}
    },

    // ⭐ 关键：setWs 函数，接收 WebSocket 实例
    setWs(ws) {
        try {
            wsInstance = ws;
            metrics.ws(ws ? 1 : 0);
        } catch (_) {}
    },

    setTokenExpiry(ts) { tokenExpiry = ts; },

    start(port) {
        if (server) return;
        port = port || parseInt(process.env.HEALTH_PORT, 10) || 9800;

        server = http.createServer(async (req, res) => {
            if (req.url === '/health' || req.url === '/live') {
                res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
            } else if (req.url === '/ready') {
                const ready = !!tokenExpiry && tokenExpiry > Date.now();
                res.statusCode = ready ? 200 : 503;
                res.end(JSON.stringify({ ready, tokenExpiry }));
            } else if (req.url === '/state') {
                res.end(JSON.stringify({
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    tokenExpiry,
                    restarts: Number(process.env.PM2_RESTART_TIME) || 0
                }));
            } else if (req.url === '/metrics') {
                res.setHeader('Content-Type', metrics.register.contentType);
                try {
                    const data = await metrics.register.metrics();
                    res.end(data);
                } catch (err) {
                    res.statusCode = 500;
                    res.end('Metrics error: ' + err.message);
                }
            } else {
                res.statusCode = 404;
                res.end('Not Found');
            }
        });

        server.listen(port, '0.0.0.0', () => {
            logger.info(`[Health] 探针已启动 http://127.0.0.1:${port} (/health /ready /state /metrics)`);
        });
    }
};
