const logger = require('../utils/logger');
const memory = require('./memory');
const repo = require('./memoryRepository');
const metrics = require('../metrics');

// ⭐ 复用项目已有的 LLM 模块
let summarizeFn = null;
try {
  const llm = require('../llm');
  summarizeFn = llm.summarize;
  logger.info('[Summarizer] ✅ LLM summarize 已加载');
} catch (e) {
  logger.warn(`[Summarizer] ⚠️ LLM 模块加载失败: ${e.message}，将使用截断降级`);
}

// ====== 配置 ======
const TRIGGER_THRESHOLD = parseInt(process.env.SUMMARY_TRIGGER || '15', 10);
const KEEP_AFTER = 5;
const SUMMARY_MAX_LEN = 500;

/**
 * 获取所有需要摘要的用户
 */
function getUsersNeedingSummary() {
  const db = memory._raw;
  const rows = db.prepare(`
    SELECT user_id, COUNT(*) as msg_count
    FROM messages
    WHERE expires_at IS NULL OR expires_at > datetime('now')
    GROUP BY user_id
    HAVING msg_count >= ?
  `).all(TRIGGER_THRESHOLD);
  return rows;
}

/**
 * 调用 LLM 生成摘要
 * @param {Array<{role:string, content:string}>} messages - 要压缩的消息
 * @param {string|null} existingSummary - 已有摘要（作为上下文）
 * @returns {Promise<string>}
 */
async function generateSummary(messages, existingSummary) {
  if (summarizeFn) {
    // ⭐ 调用项目已有的 LLM summarize
    try {
      const result = await summarizeFn(messages, existingSummary);
      if (result && result.trim().length > 0) {
        return result.trim().slice(0, SUMMARY_MAX_LEN);
      }
    } catch (e) {
      logger.error(`[Summarizer] LLM 调用失败: ${e.message}，降级为截断`);
    }
  }

  // 降级：截断拼接
  const combined = messages.map(m => `[${m.role}] ${m.content}`).join('\n');
  return combined.slice(0, SUMMARY_MAX_LEN);
}

/**
 * 对单个用户执行摘要晋升
 */
async function summarizeUser(userId) {
  const t0 = Date.now();
  try {
    const allMessages = memory.getHistory(userId);
    if (allMessages.length < TRIGGER_THRESHOLD) {
      return { skipped: true, reason: 'below_threshold' };
    }

    logger.info(`[Summarizer] 开始摘要 user=${userId} msgs=${allMessages.length}`);

    // 获取已有摘要
    const existingSummary = memory.getSummary(userId);

    // ⭐ 调用 LLM 生成摘要
    const newSummary = await generateSummary(allMessages, existingSummary);

    if (!newSummary || newSummary.trim().length === 0) {
      logger.warn(`[Summarizer] 摘要为空，跳过 user=${userId}`);
      return { skipped: true, reason: 'empty_summary' };
    }

    // 写入 user_summary 表
    memory.setSummary(userId, newSummary);

    // 写入 Qdrant 长期向量
    await repo.save(userId, newSummary, 'long', null);

    // 清理旧消息（保留最近 KEEP_AFTER 条）
    // 直接操作而非用 pruneAfterSummary（它的 KEEP 是 10）
    const db = memory._raw;
    const keepIds = db.prepare(`
      SELECT id FROM messages WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, KEEP_AFTER).map(r => r.id);

    if (keepIds.length > 0) {
      const placeholders = keepIds.map(() => '?').join(',');
      const delStmt = db.prepare(`
        DELETE FROM messages WHERE user_id = ? AND id NOT IN (${placeholders})
      `);
      const delResult = delStmt.run(userId, ...keepIds);
      logger.info(`[Summarizer] 清理旧消息 user=${userId} deleted=${delResult.changes} kept=${KEEP_AFTER}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(`[Summarizer] ✅ 摘要完成 user=${userId} len=${newSummary.length} (${elapsed}s)`);

    return {
      success: true,
      userId,
      summaryLength: newSummary.length,
      messagesProcessed: allMessages.length,
      elapsedSec: parseFloat(elapsed),
      usedLLM: !!summarizeFn
    };

  } catch (e) {
    logger.error(`[Summarizer] ❌ 摘要失败 user=${userId}: ${e.message}`);
    return { success: false, userId, error: e.message };
  }
}

/**
 * 扫描所有用户，对达到阈值的执行摘要
 */
async function scanAndSummarize() {
  const users = getUsersNeedingSummary();
  if (users.length === 0) return { scanned: 0, summarized: 0 };

  logger.info(`[Summarizer] 发现 ${users.length} 个用户需要摘要`);

  let summarized = 0;
  for (const { user_id } of users) {
    const result = await summarizeUser(user_id);
    if (result.success) summarized++;
    // 每个用户之间间隔 1 秒，避免 LLM API 限流
    if (summarizeFn && users.length > 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info(`[Summarizer] 本轮完成: ${summarized}/${users.length} 用户已摘要`);
  return { scanned: users.length, summarized };
}

module.exports = {
  scanAndSummarize,
  summarizeUser,
  generateSummary,
};
