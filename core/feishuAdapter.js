// core/feishuAdapter.js —— 飞书 OpenAPI 封装
const logger = require('../utils/logger');

const APP_ID     = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BASE_URL   = 'https://open.feishu.cn/open-apis';

let _token = null;
let _tokenExpireAt = 0;

async function getTenantAccessToken() {
  if (_token && Date.now() < _tokenExpireAt - 60000) return _token;
  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书 token 获取失败: ${data.msg}`);
  _token = data.tenant_access_token;
  _tokenExpireAt = Date.now() + data.expire * 1000;
  logger.info(`[Feishu] ✅ tenant_access_token 刷新成功, expire=${data.expire}s`);
  return _token;
}

/**
 * 发送文本消息
 * @param {string} receiveId - chat_id / open_id / user_id
 * @param {string} text      - 纯文本内容
 * @param {string} receiveIdType - 'chat_id' | 'open_id' | 'user_id' (默认 chat_id)
 */
async function sendText(receiveId, text, receiveIdType = 'chat_id') {
  if (!APP_ID || !APP_SECRET) {
    logger.warn('[Feishu] ⚠️ 未配置 FEISHU_APP_ID/SECRET，跳过发送');
    return null;
  }
  const token = await getTenantAccessToken();
  const res = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    logger.error(`[Feishu] ❌ 发送失败 code=${data.code} msg=${data.msg}`);
    throw new Error(`飞书发送失败: ${data.msg}`);
  }
  logger.info(`[Feishu] ✅ 消息已发送 → ${receiveId} (${text.length} chars)`);
  return data;
}

module.exports = { sendText, getTenantAccessToken };
