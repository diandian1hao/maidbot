const logger = require('../utils/logger');
const metrics = require('../metrics');
const repo = require('./memoryRepository');
const summarizer = require('./summarizer');
const axios = require('axios');

const VECTOR_API = process.env.VECTOR_API_URL || 'http://127.0.0.1:8000';
const WORKER_INTERVAL = parseInt(process.env.WORKER_INTERVAL || '30000', 10);       // 30秒：同步+清理
const SUMMARY_INTERVAL = parseInt(process.env.SUMMARY_INTERVAL || '1800000', 10);   // 30分钟：摘要

let syncTimer = null;
let summaryTimer = null;

// ====== 高频任务（每30秒）======
async function syncTick() {
  try {
    // ① 重试未同步的记录
    await repo.retryPending();

    // ② 清理过期短期记忆
    await repo.cleanExpired();

    // ③ 上报 Prometheus 指标
    repo.reportMetrics();

    // ④ 检测向量服务健康
    try {
      const res = await axios.get(`${VECTOR_API}/health`, { timeout: 5000 });
      metrics.vectorServiceUp.set(res.data.status === 'running' ? 1 : 0);
    } catch {
      metrics.vectorServiceUp.set(0);
    }
  } catch (e) {
    metrics.syncFailures.inc();                          // ⭐ 同步失败 +1
    logger.error(`[Worker] syncTick 异常: ${e.message}`);
  }
}

// ====== 低频任务（每30分钟）======
async function summaryTick() {
  try {
    const result = await summarizer.scanAndSummarize();
    if (result.scanned > 0) {
      logger.info(`[Worker] 摘要扫描完成: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    logger.error(`[Worker] summaryTick 异常: ${e.message}`);
  }
}

function start() {
  logger.info(`[Worker] 启动 sync=${WORKER_INTERVAL/1000}s summary=${SUMMARY_INTERVAL/1000}s`);

  // 立即执行一次同步
  syncTick();

  // 延迟 10 秒后执行第一次摘要扫描（避免启动时抢资源）
  setTimeout(() => summaryTick(), 10000);

  syncTimer = setInterval(syncTick, WORKER_INTERVAL);
  syncTimer.unref();

  summaryTimer = setInterval(summaryTick, SUMMARY_INTERVAL);
  summaryTimer.unref();
}

function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  logger.info('[Worker] 已停止');
}

module.exports = { start, stop };
