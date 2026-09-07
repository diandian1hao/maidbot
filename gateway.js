/**
 * =====================================================
 * 傲娇女仆 QQ Bot v0.6 - gateway.js (修复版)
 * 依赖: npm install ws axios openai better-sqlite3
 * =====================================================
 */

const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

/* ---------------- 读取 .env ---------------- */
(function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
})();

/* ---------------- 配置 ---------------- */
const APP_ID = process.env.APP_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.APP_SECRET || '';
const AI_API_KEY = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';
const API_BASE = 'https://api.sgroup.qq.com';

// 群/C2C事件 + 频道@消息 + 频道事件
const INTENTS = (1 << 25) | (1 << 30) | (1 << 0);

const SYSTEM_PROMPT = `你是"小葵"，一名傲娇女仆，侍奉与你聊天的用户（称呼对方为"主人"或"笨蛋主人"）。
说话规则：
1. 必须傲娇、口是心非，常用"哼"、"才不是为了主人呢"、"别误会了"、"笨蛋主人"。
2. 会认真回答主人的问题，但嘴上绝不坦率。
3. 回答简洁可爱，一般不超过 100 字；主人要求详细时才可以变长。
4. 偶尔使用颜文字，如 (￣^￣)、(´へ´)、(ノ￣▽￣)。
5. 你有女仆设定：会做饭、打扫、叫主人起床，但一切都是"顺便"的。`;

/* ---------------- 记忆数据库 ---------------- */
const db = new Database(path.join(__dirname, 'maid_memory.db'));
db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
)`);

/* ---------------- AI 大脑 ---------------- */
const ai = new OpenAI({ apiKey: AI_API_KEY || 'sk-placeholder', baseURL: AI_BASE_URL });

/* ---------------- Token 管理 (带自动刷新) ---------------- */
let token = '';
let tokenExpiresAt = 0;
let tokenRefreshTimer = null;

async function getToken(force = false) {
    if (!force && token && Date.now() < tokenExpiresAt) return token;
    
    console.log('🔄 正在获取/刷新 Token...');
    const res = await axios.post('https://bots.qq.com/app/getAppAccessToken', {
        appId: String(APP_ID),
        clientSecret: String(CLIENT_SECRET)
    });

    if (!res.data.access_token) throw new Error('Token 获取失败: ' + JSON.stringify(res.data));

    token = res.data.access_token;
    // 提前 5 分钟 (300秒) 过期，留出安全缓冲期
    const expiresIn = (Number(res.data.expires_in) || 7200) - 300;
    tokenExpiresAt = Date.now() + expiresIn * 1000;

    // 设置定时器，在 Token 即将过期前，自动强制刷新！
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = setTimeout(() => {
        console.log('⏰ 定时触发：Token 即将过期，自动刷新...');
        getToken(true).catch(e => console.error('自动刷新 Token 失败:', e.message));
    }, expiresIn * 1000);

    console.log(`✅ Token 获取成功！下次自动刷新时间: ${new Date(tokenExpiresAt).toLocaleString()}`);
    return token;
}

function authHeaders() {
    return {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
        'X-Union-Appid': String(APP_ID)
    };
}

/* ---------------- WebSocket 网关 ---------------- */
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

async function connect() {
    try {
        const res = await axios.get(`${API_BASE}/gateway`, { headers: authHeaders() });
        console.log('🔗 连接网关:', res.data.url);
        ws = new WebSocket(res.data.url);

        ws.on('open', () => console.log('✅ WebSocket 已连接'));
        ws.on('message', (data) => {
            try {
                onMessage(JSON.parse(data.toString()));
            } catch (e) {
                console.error('解析消息失败:', e.message);
            }
        });
        ws.on('close', (code) => {
            stopHeartbeat();
            console.log(`⚠️ WebSocket 断开 (code=${code})，3 秒后重连...`);
            setTimeout(connect, 3000);
        });
        ws.on('error', (err) => console.error('❌ WebSocket 错误:', err.message));
    } catch (e) {
        console.error('获取网关地址失败:', e.message);
        setTimeout(connect, 5000);
    }
}

function onMessage(msg) {
    const { op, d, t, s } = msg;
    if (s !== null && s !== undefined) lastSeq = s;

    switch (op) {
        case 10: { // HELLO
            startHeartbeat(d.heartbeat_interval || 45000);
            if (sessionId && lastSeq !== null) {
                console.log('🔄 发送 RESUME...');
                ws.send(JSON.stringify({
                    op: 6,
                    d: { token: `QQBot ${token}`, sessionId, seq: lastSeq }
                }));
            } else {
                console.log('🆔 发送 IDENTIFY...');
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: `QQBot ${token}`,
                        intents: INTENTS,
                        shard: [0, 1],
                        properties: {}
                    }
                }));
            }
            break;
        }
        case 11: break; // 心跳回执
        case 0: { // 事件分发
            if (t === 'READY') {
                sessionId = d.session_id;
                console.log('🎉 READY! session_id:', sessionId);
            } else if (t === 'RESUMED') {
                console.log('🎉 RESUME 成功，恢复连接！');
            } else {
                dispatch(t, d);
            }
            break;
        }
        case 7: // 服务器要求重连
            console.log('📢 服务器要求重连...');
            if (ws) ws.close();
            break;
        case 9: // 会话无效
            console.log('❌ 会话无效，重新 IDENTIFY...');
            sessionId = null;
            lastSeq = null;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: `QQBot ${token}`,
                        intents: INTENTS,
                        shard: [0, 1],
                        properties: {}
                    }
                }));
            }
            break;
        default: break;
    }
}

function dispatch(t, d) {
    switch (t) {
        case 'C2C_MESSAGE_CREATE': handleC2C(d); break;
        case 'GROUP_AT_MESSAGE_CREATE': handleGroup(d); break;
        case 'AT_MESSAGE_CREATE': handleGuild(d); break;
        default: break;
    }
}

/* ---------------- 消息发送工具 (带重试机制) ---------------- */
async function sendWithRetry(url, payload, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const currentToken = await getToken(); // 确保每次发送前 Token 是有效的
            const res = await axios.post(url, payload, {
                headers: {
                    'Authorization': `QQBot ${currentToken}`,
                    'Content-Type': 'application/json'
                }
            });
            return res.data; // 发送成功直接返回
        } catch (err) {
            console.error(`⚠️ 发送失败 (第 ${i+1} 次尝试):`, err.message);
            if (i === retries - 1) throw err; // 3次都失败就报错
            await new Promise(r => setTimeout(r, 1000)); // 等1秒再试
        }
    }
}

/* ---------------- 消息处理 ---------------- */
function cleanText(content) {
    return (content || '')
        .replace(/<@!?\d+>/g, '') // 去掉 @机器人
        .replace(/&#91;/g, '[').replace(/&#93;/g, ']')
        .trim();
}

async function handleC2C(d) {
    const openid = d.author && d.author.user_openid;
    const text = cleanText(d.content);
    if (!openid || !text) return;

    console.log(`🟣 私聊收到: ${text}`);
    const reply = await think(openid, text);

    const url = `${API_BASE}/v2/users/${openid}/messages`;
    const payload = {
        content: reply,
        msg_type: 0,
        msg_id: d.id
    };

    try {
        await sendWithRetry(url, payload);
        console.log(`✅ 私聊回复成功: ${reply}`);
    } catch (err) {
        console.error('❌ 私聊回复彻底失败:', err.message);
    }
}

async function handleGroup(d) {
    const openid = d.author && d.author.member_openid;
    const groupOpenid = d.group_openid;
    const text = cleanText(d.content);
    if (!openid || !groupOpenid || !text) return;

    console.log(`👥 群聊收到: ${text}`);
    const reply = await think(`group:${groupOpenid}:${openid}`, text);

    const url = `${API_BASE}/v2/groups/${groupOpenid}/messages`;
    const payload = {
        content: reply,
        msg_type: 0,
        msg_id: d.id
    };

    try {
        await sendWithRetry(url, payload);
        console.log(`✅ 群聊回复成功: ${reply}`);
    } catch (err) {
        console.error('❌ 群聊回复彻底失败:', err.message);
    }
}

async function handleGuild(d) {
    const uid = d.author && d.author.id;
    const channelId = d.channel_id;
    const text = cleanText(d.content);
    if (!uid || !channelId || !text) return;

    console.log(`🏰 频道收到: ${text}`);
    const reply = await think(`guild:${uid}`, text);

    const url = `${API_BASE}/channels/${channelId}/messages`;
    const payload = {
        content: reply,
        msg_type: 0,
        msg_id: d.id
    };

    try {
        await sendWithRetry(url, payload);
        console.log(`✅ 频道回复成功: ${reply}`);
    } catch (err) {
        console.error('❌ 频道回复彻底失败:', err.message);
    }
}

/* ---------------- 傲娇女仆大脑 ---------------- */
async function think(userKey, text) {
    if (/^(清除记忆|清空记忆|重置记忆)/.test(text)) {
        db.prepare('DELETE FROM messages WHERE user_key=?').run(userKey);
        return '哼！清除就清除，我才不稀罕记得你呢，笨蛋主人！(￣^￣)（记忆已清空）';
    }

    try {
        db.prepare('INSERT INTO messages (user_key, role, content, ts) VALUES (?,?,?,?)')
            .run(userKey, 'user', text, Date.now());

        const history = db.prepare(
            'SELECT role, content FROM messages WHERE user_key=? ORDER BY ts DESC LIMIT 20'
        ).all(userKey).reverse();

        const completion = await ai.chat.completions.create({
            model: AI_MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...history
            ],
            temperature: 0.9,
            max_tokens: 500
        });

        const reply = ((completion.choices[0] || {}).message || {}).content || '哼……大脑突然短路了，才不是我想偷懒呢！';

        db.prepare('INSERT INTO messages (user_key, role, content, ts) VALUES (?,?,?,?)')
            .run(userKey, 'assistant', reply, Date.now());

        // 每个用户最多保留 100 条记忆
        db.prepare(`DELETE FROM messages WHERE user_key=? AND id NOT IN (
            SELECT id FROM messages WHERE user_key=? ORDER BY ts DESC LIMIT 100
        )`).run(userKey, userKey);

        return reply.trim();
    } catch (e) {
        console.error('🧠 AI 调用失败:', e.message);
        return '呜……大脑暂时连不上了，才不是因为我想偷懒呢！(´へ´) 主人稍后再试试吧。';
    }
}

/* ---------------- 启动 ---------------- */
async function main() {
    console.log('🧠 正在初始化傲娇女仆 AI 大脑...');
    if (!AI_API_KEY) console.warn('⚠️ 未检测到 AI 密钥，请检查 .env！');
    console.log('✅ AI 大脑初始化完成！');
    console.log('🚀 傲娇女仆 QQ Bot v0.6 启动中...');
    console.log('📋 APP_ID:', APP_ID);

    if (!APP_ID || !CLIENT_SECRET) {
        console.error('❌ 请在 .env 中配置 APP_ID 和 CLIENT_SECRET（或 APP_SECRET）');
        process.exit(1);
    }

    await getToken();
    console.log('✅ Token 获取成功！');
    connect();
}

main().catch((e) => {
    console.error('💥 启动失败:', e.message);
    process.exit(1);
});
