const WebSocket = require('ws');
const axios = require('axios');
const { getToken } = require('./tokenManager');

const APP_ID = process.env.APP_ID || '';
const API_BASE = 'https://api.sgroup.qq.com';
const INTENTS = (1 << 25);

let ws = null;
let sessionId = null;
let lastSeq = null;
let heartbeatTimer = null;

function startHeartbeat(interval) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: lastSeq }));
        }
    }, interval);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

async function sendWithRetry(url, payload, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const currentToken = await getToken();
            const res = await axios.post(url, payload, {
                headers: {
                    'Authorization': `QQBot ${currentToken}`,
                    'Content-Type': 'application/json'
                }
            });
            return res.data;
        } catch (err) {
            console.error(`⚠️ 发送失败 (第 ${i+1} 次尝试):`, err.message);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

function cleanText(content) {
    return (content || '')
        .replace(/<@!?\d+>/g, '')
        .replace(/&#91;/g, '[').replace(/&#93;/g, ']')
        .trim();
}

async function connect(messageHandler) {
    try {
        const token = await getToken();
        const res = await axios.get(`${API_BASE}/gateway`, { 
            headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' } 
        });
        console.log('🔗 连接网关:', res.data.url);
        ws = new WebSocket(res.data.url);

        ws.on('open', () => console.log('✅ WebSocket 已连接'));
        ws.on('message', (data) => {
            try { onMessage(JSON.parse(data.toString()), messageHandler); } 
            catch (e) { console.error('解析消息失败:', e.message); }
        });
        ws.on('close', (code) => {
            stopHeartbeat();
            console.log(`⚠️ WebSocket 断开 (code=${code})，3 秒后重连...`);
            setTimeout(() => connect(messageHandler), 3000);
        });
        ws.on('error', (err) => console.error('❌ WebSocket 错误:', err.message));
    } catch (e) {
        console.error('获取网关地址失败:', e.message);
        setTimeout(() => connect(messageHandler), 5000);
    }
}

function onMessage(msg, messageHandler) {
    const { op, d, t, s } = msg;
    if (s !== null && s !== undefined) lastSeq = s;

    switch (op) {
        case 10: {
            startHeartbeat(d.heartbeat_interval || 45000);
            if (sessionId && lastSeq !== null) {
                ws.send(JSON.stringify({ op: 6, d: { token: `QQBot ${token}`, sessionId, seq: lastSeq } }));
            } else {
                console.log('🆔 发送 IDENTIFY...');
                ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1], properties: {} } }));
            }
            break;
        }
        case 11: break;
        case 0: {
            if (t === 'READY') {
                sessionId = d.session_id;
                console.log('🎉 READY! session_id:', sessionId);
            } else if (t === 'RESUMED') {
                console.log('🎉 RESUME 成功，恢复连接！');
            } else {
                messageHandler(t, d);
            }
            break;
        }
        case 7: if (ws) ws.close(); break;
        case 9: 
            sessionId = null; lastSeq = null;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1], properties: {} } }));
            }
            break;
    }
}

module.exports = { connect, sendWithRetry, cleanText, API_BASE };
