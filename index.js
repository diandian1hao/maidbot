require('dotenv').config({ override: true });
const { MaidBot } = require('./core/bot');
const PluginManager = require('./core/manager');
const logger = require('./utils/logger');
const path = require('path');
const memory = require('./core/memory');
const health = require('./core/health');
const alert  = require('./core/alert');
const metrics = require('./metrics');           // ⭐ 统一 metrics（根目录）
const repo = require('./core/memoryRepository');
const worker = require('./core/worker');

const pluginDir = process.env.PLUGIN_DIR || path.join(__dirname, 'plugins');

if (typeof MaidBot !== 'function') {
  console.error('❌ 致命错误: core/bot.js 中未导出 MaidBot 类');
  process.exit(1);
}

// ====== 事件分发核心 ======
async function dispatch(bot, t, d) {
  const MSG_EVENTS = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'];
  if (!MSG_EVENTS.includes(t)) return;
  health.messageReceived();

  const userId = d.author?.user_openid || d.author?.id || 'unknown';
  const text = (d.content || '').trim();
  const msgType = t === 'C2C_MESSAGE_CREATE' ? 'C2C' : 'GROUP';
  metrics.msg(msgType);                          // ⭐ 用统一 metrics 的便捷方法

  logger.info(`[Dispatch] 收到消息 type=${t} user=${userId} text="${text.slice(0, 30)}"`);

  // 🔍 P3: 向量搜索（带用户隔离，异步不阻塞）
  if (text && userId !== 'unknown') {
    repo.search(userId, text, { topK: 3 }).then(results => {
      if (results.length) {
        logger.info(`[Dispatch] 向量搜索命中 ${results.length} 条 (user=${userId})`);
      }
    }).catch(() => {});
  }

  if (!text && !(d.attachments && d.attachments.length)) return;

  const sorted = [...pluginManager.plugins.values()]
    .filter(p => typeof p.handleMessage === 'function')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  let reply = null;
  for (const plugin of sorted) {
    try {
      const msgData = {
        sender_id: userId, author: d.author, content: text,
        id: d.id, group_openid: d.group_openid, channel_id: d.channel_id, raw: d,
      };
      reply = await plugin.handleMessage(msgData, bot);
      if (reply) {
        logger.info(`[Dispatch] 插件 ${plugin.name} 产出回复 (${String(reply).length} chars)`);
        break;
      }
    } catch (e) {
      logger.error(`[Dispatch] 插件 ${plugin.name} 异常: ${e.message}`);
    }
  }

  // 💾 P3: 将用户消息存入记忆（短期）
  if (text && userId !== 'unknown') {
    repo.save(userId, text, 'short').catch(e => {
      logger.warn(`[Dispatch] 记忆写入失败: ${e.message}`);
    });
  }

  if (!reply) return;

  try {
    if (t === 'C2C_MESSAGE_CREATE') {
      await bot.api.replyC2C(d.author.user_openid, d.id, String(reply));
    } else {
      logger.warn(`[Dispatch] ${t} 回复接口未实现`);
    }
  } catch (e) {
    logger.error(`[Dispatch] 回复失败: ${e.message}`);
  }
}

const bot = new MaidBot({
  appId: process.env.APP_ID,
  appSecret: process.env.APP_SECRET,
  onEvent: (t, d) => {
    dispatch(bot, t, d).catch(e => {
      logger.error(`[Dispatch] 未捕获: ${e.message}`);
      try { alert.alertCritical('Dispatch 未捕获: ' + e.message); } catch(_){}
    });
  },
});

const pluginManager = new PluginManager(bot);

// ====== P0: 优雅退出 ======
let shuttingDown = false;

function getRawDb() {
  if (!memory) return null;
  return memory._raw || memory.db || memory.raw || memory.database || null;
}

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[P0] 收到 ${signal}，开始优雅退出...`);

  // 1. 停止 worker
  try { worker.stop(); } catch(e) {}

  // 2. 停止接收新消息
  try {
    if (bot && typeof bot.stop === 'function') {
      bot.stop();
      logger.info('[P0] step1 ✅ WebSocket 已关闭');
    }
  } catch (e) {
    logger.error(`[P0] step1 ❌ ${e.message}`);
  }

  // 3. WAL checkpoint
  try {
    const raw = getRawDb();
    if (raw && typeof raw.pragma === 'function') {
      const r = raw.pragma('wal_checkpoint(TRUNCATE)');
      logger.info(`[P0] step2 ✅ WAL checkpoint ${JSON.stringify(r)}`);
    }
  } catch (e) {
    logger.error(`[P0] step2 ❌ ${e.message}`);
  }

  // 4. 关闭数据库
  try {
    const raw = getRawDb();
    if (raw && typeof raw.close === 'function') {
      raw.close();
      logger.info('[P0] step3 ✅ SQLite 已关闭');
    }
  } catch (e) {
    logger.error(`[P0] step3 ❌ ${e.message}`);
  }

  logger.info('[P0] 优雅退出完成');
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  logger.error(`[P0] 未捕获异常: ${e.message}\n${e.stack}`);
});
process.on('unhandledRejection', (e) => {
  logger.error(`[P0] 未处理拒绝: ${e && e.message ? e.message : e}`);
});

// ====== P0: 定时备份 ======
setInterval(() => {
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/backup_db.js', { cwd: __dirname, timeout: 30000 });
    logger.info('[P0] 定时备份完成');
  } catch (e) {
    logger.error(`[P0] 备份失败: ${e.message}`);
  }
}, 6 * 3600 * 1000).unref();

// ====== 启动 ======
async function start() {
  try {
    logger.info('🚀 MaidBot starting up...');
    await pluginManager.loadAll(pluginDir);
    const count = pluginManager.getPluginCount();
    logger.info(`🔌 Loaded ${count} plugins.`);
    if (count === 0) logger.warn('⚠️ No plugins loaded!');

    await bot.start();
    alert.bindBot(bot);
    health.incRestart();
    health.start();              // :9800 探针 + /metrics（health.js 内部已处理）

    // 🆕 启动双库联动 worker
    worker.start();

    // 🆕 首次上报指标
    repo.reportMetrics();

    try { alert.alertInfo('MaidBot 已启动, plugins=' + count); } catch(_){}
    logger.info('[P0+P3] ✅ 所有基础保障 + 双库联动已就绪');
  } catch (error) {
    logger.error('❌ Startup failed: ' + error.message);
    process.exit(1);
  }
}

start();
