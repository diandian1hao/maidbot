const fs = require('fs');
const path = require('path');

// 1. 强制指定绝对路径，防止任何路径解析错误
const logDir = '/home/ubuntu/maidbot/logs';
const logFile = path.join(logDir, 'maidbot-access.log');

// 2. 确保目录存在
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// 3. 创建一个简单的写入流 (Append模式)
const stream = fs.createWriteStream(logFile, { flags: 'a' });

// P1: 统一格式化 + 双写工具
function _write(level, msg, sink) {
    const logLine = `[${new Date().toISOString()}] ${level}: ${msg}\n`;
    sink(logLine);          // 控制台（stdout 或 stderr）
    stream.write(logLine);  // 文件
}

const logger = {
    info: (msg) => {
        _write('INFO', msg, (l) => process.stdout.write(l));
    },
    warn: (msg) => {
        // WARN 走 stderr，便于和 ERROR 一起在 maidbot-error.log 里被 pm2 捕获
        _write('WARN', msg, (l) => process.stderr.write(l));
    },
    error: (msg) => {
        _write('ERROR', msg, (l) => process.stderr.write(l));
    },
    debug: (msg) => {
        // DEBUG 仅在开启调试时输出到控制台，但始终写文件（方便事后排查）
        const logLine = `[${new Date().toISOString()}] DEBUG: ${msg}\n`;
        if (process.env.DEBUG === '1' || process.env.LOG_DEBUG === '1') {
            process.stdout.write(logLine);
        }
        stream.write(logLine);
    }
};

module.exports = logger;
