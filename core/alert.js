const logger = require('../utils/logger');

// ====== 配置 ======
const COOLDOWN_MS = 10 * 60 * 1000;   // 同类告警 10 分钟冷却
const ALERT_OWNER_ID = process.env.ALERT_OWNER_ID || '';  // 你的 QQ openid

// ====== 冷却记录 ======
const cooldownMap = new Map();  // key → lastSentTimestamp

function _shouldSend(key) {
  const last = cooldownMap.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  cooldownMap.set(key, Date.now());
  return true;
}

// ====== 核心发送函数 ======
// botInstance: MaidBot 实例（延迟注入，避免循环依赖）
let _bot = null;
function bindBot(bot) { _bot = bot; }

async function send(text, category) {
  category = category || 'default';

  // 冷却检查
  if (!_shouldSend(category)) {
    logger.debug(`[Alert] 告警被冷却跳过 (${category}): ${String(text).slice(0, 40)}`);
    return;
  }

  // 没有绑定 bot 或没有配置接收人 → 仅打日志
  if (!_bot || !ALERT_OWNER_ID) {
    logger.warn(`[Alert] ⚠️ 未配置告警通道 (bot=${!!_bot}, owner=${ALERT_OWNER_ID}): ${text}`);
    return;
  }

  try {
    // 复用女仆自己的 C2C 接口给自己发消息
    // 注意：这里不能用 d.id 做 msg_id，传空字符串让 SDK 自动生成
    await _bot.api.replyC2C(ALERT_OWNER_ID, '', `[MaidBot 告警]\n${text}`);
    logger.info(`[Alert] ✅ 告警已发送 (${category})`);
  } catch (e) {
    // 告警本身失败不能再触发告警，否则死循环
    logger.error(`[Alert] ❌ 告警发送失败: ${e.message}`);
  }
}

// ====== 便捷方法 ======
async function alertCritical(msg)  { return send(`🔴 CRITICAL\n${msg}`, 'critical'); }
async function alertWarning(msg)   { return send(`🟡 WARNING\n${msg}`,  'warning'); }
async function alertInfo(msg)      { return send(`🔵 INFO\n${msg}`,     'info'); }

module.exports = { bindBot, send, alertCritical, alertWarning, alertInfo };
