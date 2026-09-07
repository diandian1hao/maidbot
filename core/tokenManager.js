const axios = require('axios');

// --- 【核心修复】增加了 .trim() 和备选变量名，防止空格和命名错误 ---
const APP_ID = (process.env.APP_ID || '').trim();
const CLIENT_SECRET = (process.env.CLIENT_SECRET || process.env.APP_SECRET || '').trim();

let token = '';
let tokenExpiresAt = 0;
let isRefreshing = false; // 防止并发刷新 Token

/**
 * 获取 Token 的核心函数
 * @param {boolean} force - 是否强制刷新
 */
async function getToken(force = false) {
    // 如果还没到过期时间，且不是强制刷新，直接返回缓存
    if (!force && token && Date.now() < tokenExpiresAt) {
        return token;
    }

    // 防止多个请求同时触发刷新
    if (isRefreshing) {
        // 简单等待一下，实际项目中可以用事件队列，这里简化处理
        await new Promise(r => setTimeout(r, 1000)); 
        return token; 
    }

    isRefreshing = true;

    // 【关键修复】在这里才进行校验，而不是文件加载时就校验
    if (!APP_ID || !CLIENT_SECRET) {
        console.error('❌ 致命错误：无法获取 APP_ID 或 CLIENT_SECRET');
        console.error('👉 请检查 .env 文件，确保包含 APP_ID 和 CLIENT_SECRET');
        console.error(`👉 当前读取到的 APP_ID: ${APP_ID ? '***' + APP_ID.slice(-4) : '空'}`);
        isRefreshing = false;
        throw new Error('环境变量配置缺失');
    }

    try {
        console.log('🔄 正在向腾讯服务器申请通行证 (Token)...');
        const res = await axios.post('https://bots.qq.com/app/getAppAccessToken', {
            appId: String(APP_ID),
            clientSecret: String(CLIENT_SECRET)
        });

        if (!res.data.access_token) {
            throw new Error('腾讯返回的数据里没有 Token: ' + JSON.stringify(res.data));
        }

        token = res.data.access_token;
        // 设置过期时间（提前 60 秒刷新，保平安）
        tokenExpiresAt = Date.now() + (res.data.expire_in - 60) * 1000;
        
        console.log('✅ Token 获取成功！有效期到:', new Date(tokenExpiresAt).toLocaleTimeString());
        return token;

    } catch (error) {
        console.error('❌ Token 获取失败:', error.message);
        // 失败时不重置 token，保留旧的可能还能用一会儿，或者抛出错误让上层处理
        throw error;
    } finally {
        isRefreshing = false;
    }
}

module.exports = {
    getToken
};
