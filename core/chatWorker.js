// core/chatWorker.js —— BullMQ Chat Consumer + 多端主动回复
const { Worker } = require('bullmq');
const logger = require('../utils/logger');
const feishu = require('./feishuAdapter');

// 延迟获取 processMessage，避免循环引用时序问题
let _processMessage;
function getProcessMessage() {
  if (!_processMessage) {
    _processMessage = require('../index').processMessage;
    if (!_processMessage) throw new Error('[ChatWorker] processMessage 未就绪');
  }
  return _processMessage;
}

// ====== 多端回复路由 ======
async function deliverReply(source, reply, msgData) {
  if (!reply) return;

  switch (source) {
    case 'feishu': {
      // msgData.raw 中应包含 chat_id 或 open_id
      const chatId = msgData?.raw?.chat_id || msgData?.raw?.event?.message?.chat_id;
      if (!chatId) {
        logger.warn('[ChatWorker] ⚠️ feishu 消息缺少 chat_id，无法回复');
        return;
      }
      await feishu.sendText(chatId, reply, 'chat_id');
      break;
    }
    case 'qq': {
      // QQ 端回复由 dispatch 处理，队列仅做 AI 推理
      // 若后续需要 QQ 主动推送，在此扩展
      logger.debug(`[ChatWorker] QQ 回复由 dispatch 层处理，跳过主动推送`);
      break;
    }
    default:
      logger.warn(`[ChatWorker] ⚠️ 未知 source=${source}，仅打印回复: ${reply.slice(0, 80)}`);
  }
}

// ====== BullMQ Worker ======
const worker = new Worker('maidbot_chat', async (job) => {
  const { userId, text, opts } = job.data;
  const source = opts?.source || 'unknown';
  logger.info(`[ChatWorker] ▶️ job=${job.id} user=${userId} source=${source}`);

  const result = await getProcessMessage()(userId, text, opts);
  const reply = result?.reply || '';

  // 🆕 Step 2c: 根据 source 路由到对应平台 API
  try {
    await deliverReply(source, reply, result?.msgData);
  } catch (e) {
    logger.error(`[ChatWorker] ❌ 回复投递失败 source=${source}: ${e.message}`);
  }

  logger.info(`[ChatWorker] ✅ job=${job.id} done reply=${reply.length}chars plugin=${result?.plugin}`);
  return result;
}, {
  connection: { host: '127.0.0.1', port: 6379 },
  concurrency: 3,
  limiter: { max: 10, duration: 1000 },
});

worker.on('failed', (job, err) => {
  logger.error(`[ChatWorker] ❌ job=${job?.id} failed(attempt=${job?.attemptsMade}): ${err.message}`);
});

worker.on('completed', (job) => {
  logger.debug(`[ChatWorker] ✔️ job=${job.id} completed`);
});

logger.info('[ChatWorker] 🚀 BullMQ Chat Worker 已启动 (queue=maidbot_chat, concurrency=3, 多端回复已接入)');

module.exports = worker;
