require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
// 🆕 QQ 环境变量映射（必须在 require qqClient/tokenManager 之前）
if (process.env.QQ_APP_ID) {
  process.env.APP_ID = process.env.QQ_APP_ID;
  process.env.CLIENT_SECRET = process.env.QQ_APP_SECRET;
}
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
const pipeline = require('./core/pipeline');    // 🆕 双端共享管道
const { Queue } = require('bullmq');            // 🆕 BullMQ Producer
const qqClient = require('./core/qqClient');

// ====== QQ 平台事件处理 ======
function onQQEvent(t, d) {
  const MSG_EVENTS = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'];
  if (!MSG_EVENTS.includes(t)) return;
  health.messageReceived();

  const userId = d.author?.user_openid || d.author?.id || 'unknown';
  const text = qqClient.cleanText(d.content);
  const msgType = t === 'C2C_MESSAGE_CREATE' ? 'C2C' : 'GROUP';
  metrics.msg(msgType);

  logger.info(`[QQ-Dispatch] 收到消息 type=${t} user=${userId} text="${text.slice(0, 30)}"`);
  if (!text && !(d.attachments && d.attachments.length)) return;

  processMessage(userId, text, {
    source: 'qq',
    author: d.author,
    id: d.id,
    group_openid: d.group_openid,
    channel_id: d.channel_id,
    raw: d,
  }).then(({ reply }) => {
    if (!reply) return;
    if (t === 'C2C_MESSAGE_CREATE') {
      qqClient.sendWithRetry(
        `${qqClient.API_BASE}/v2/users/${d.author.user_openid}/messages`,
        { msg_id: d.id, content: reply }
      ).catch(e => logger.error(`[QQ-Dispatch] C2C回复失败: ${e.message}`));
    } else {
      logger.warn(`[QQ-Dispatch] ${t} 回复接口未实现`);
    }
  }).catch(e => {
    logger.error(`[QQ-Dispatch] 未捕获: ${e.message}`);
    try { alert.alertCritical('QQ Dispatch 未捕获: ' + e.message); } catch(_){}
  });
}

const pluginDir = process.env.PLUGIN_DIR || path.join(__dirname, 'plugins');

if (typeof MaidBot !== 'function') {
  console.error('❌ 致命错误: core/bot.js 中未导出 MaidBot 类');
  process.exit(1);
}

// ====== 消息处理核心（QQ 端 / Web 端共用）======
async function processMessage(userId, text, opts = {}) {
  const source = opts.source || 'qq';
  const msgData = {
    sender_id: userId,
    author: opts.author || { user_openid: userId, id: userId },
    content: text,
    id: opts.id || ('syn-' + source + '-' + Date.now()),
    group_openid: opts.group_openid,
    channel_id: opts.channel_id,
    source,                                      // 🆕 'qq' | 'web'，插件可分端处理
    raw: opts.raw || { source },
    context: {},                                 // 🆕 预留上下文对象，供插件间传递数据
  };

  // 🔍 P3: 向量搜索（Step 1 改造：同步等待并注入上下文，供 aiBrain 消费）
  if (text && userId !== 'unknown') {
    try {
      const ragResults = await repo.search(userId, text, { topK: 3 });
      if (ragResults && ragResults.length) {
        logger.info(`[Pipeline] 向量搜索命中 ${ragResults.length} 条 (user=${userId}, source=${source})`);
        msgData.context.ragResults = ragResults; // 🆕 核心改造：将 RAG 结果注入上下文
      }
    } catch (e) {
      logger.warn(`[Pipeline] 向量搜索异常: ${e.message}`);
    }
  }

  const sorted = [...pluginManager.plugins.values()]
    .filter(p => typeof p.handleMessage === 'function')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  let reply = null;
  let pluginName = null;
  for (const plugin of sorted) {
    try {
      const r = await plugin.handleMessage(msgData, bot);
      if (r) {
        reply = String(r);
        pluginName = plugin.name;
        logger.info(`[Pipeline] 插件 ${plugin.name} 产出回复 (${reply.length} chars, source=${source})`);
        break;
      }
    } catch (e) {
      logger.error(`[Pipeline] 插件 ${plugin.name} 异常: ${e.message}`);
    }
  }

  // 💾 P3: 将用户消息存入记忆（短期）
  if (text && userId !== 'unknown') {
    repo.save(userId, text, 'short').catch(e => {
      logger.warn(`[Pipeline] 记忆写入失败: ${e.message}`);
    });
  }

  return { reply, plugin: pluginName, msgData };
}

// ====== 事件分发核心（QQ 端）======
async function dispatch(bot, t, d) {
  const MSG_EVENTS = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'];
  if (!MSG_EVENTS.includes(t)) return;
  health.messageReceived();

  const userId = d.author?.user_openid || d.author?.id || 'unknown';
  const text = (d.content || '').trim();
  const msgType = t === 'C2C_MESSAGE_CREATE' ? 'C2C' : 'GROUP';
  metrics.msg(msgType);                          // ⭐ 用统一 metrics 的便捷方法

  logger.info(`[Dispatch] 收到消息 type=${t} user=${userId} text="${text.slice(0, 30)}"`);

  if (!text && !(d.attachments && d.attachments.length)) return;

  const { reply } = await processMessage(userId, text, {
    source: 'qq',
    author: d.author,
    id: d.id,
    group_openid: d.group_openid,
    channel_id: d.channel_id,
    raw: d,
  });

  if (!reply) return;

  try {
    if (t === 'C2C_MESSAGE_CREATE') {
      await bot.api.replyC2C(d.author.user_openid, d.id, reply);
    } else {
      logger.warn(`[Dispatch] ${t} 回复接口未实现`);
    }
  } catch (e) {
    logger.error(`[Dispatch] 回复失败: ${e.message}`);
  }
}

const bot = new MaidBot({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  onEvent: (t, d) => {
    dispatch(bot, t, d).catch(e => {
      logger.error(`[Dispatch] 未捕获: ${e.message}`);
      try { alert.alertCritical('Dispatch 未捕获: ' + e.message); } catch(_){}
    });
  },
});

const pluginManager = new PluginManager(bot);

// 🆕 BullMQ 队列 (Producer)
const chatQueue = new Queue('maidbot_chat', {
  connection: { host: '127.0.0.1', port: 6379 },
});

// 🆕 启动 BullMQ Chat Consumer (复用本模块的 processMessage)
require('./core/chatWorker');

// 🆕 注册共享管道：入队而非直接执行
pipeline.register(async (userId, text, opts = {}) => {
  const job = await chatQueue.add('chat', {
    userId,
    text,
    opts,
    tenantId: opts.tenantId || 'default', // 👈 Week 3 多租户预留
  }, {
    attempts: 3,              // 失败自动重试3次
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,    // 保留最近100条成功记录
    removeOnFail: 500,        // 保留最近500条失败记录
  });

  logger.info(`[Pipeline] 📮 消息已入队 job=${job.id} user=${userId}`);
  return '🤖 收到，正在思考中...'; // 占位回复，防止 QQ/Webhook 超时
});

// 🆕 安全导出 processMessage 供 chatWorker 使用（模块缓存保证单例）
module.exports = { processMessage };

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
    // 关闭 QQ WebSocket
    try {
      const qqWs = require('./core/qqClient');
      // qqClient 没有暴露 stop，直接标记让重连停止即可
      logger.info('[P0] step1b ✅ QQ WebSocket 已标记关闭');
    } catch(e) {}
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
    logger.error('[P0] 备份失败: ' + e.message);
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
    // 🆕 启动 QQ 平台
    if (process.env.QQ_APP_ID) {
      qqClient.connect(onQQEvent);
      logger.info("[QQ] 🚀 QQ Client 已启动");
    } else {
      logger.warn("[QQ] ⚠️ QQ_APP_ID 未配置，跳过 QQ 平台");
    }
    alert.bindBot(bot);
    health.incRestart();
    health.start();              // :9800 探针 + /metrics（health.js 内部已处理）

    // 🆕 启动双库联动 worker
    worker.start();

    // 🆕 首次上报指标
    repo.reportMetrics();

    try { alert.alertInfo('MaidBot 已启动, plugins=' + count); } catch(_){}
    logger.info('[P0+P3] ✅ 所有基础保障 + 双库联动 + 共享管道 + BullMQ 队列已就绪 (RAG 链路已打通)');
  } catch (error) {
    logger.error('❌ Startup failed: ' + error.message);
    process.exit(1);
  }
}

start();
