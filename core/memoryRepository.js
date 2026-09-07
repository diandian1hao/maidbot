const axios = require('axios');
const dbModule = require('./db');
const metrics = require('../metrics');       // ⭐ 指向根目录的统一 metrics
const logger = require('../utils/logger');

const VECTOR_API = process.env.VECTOR_API_URL || 'http://127.0.0.1:8000';
const COLLECTION = process.env.QDRANT_COLLECTION || 'my_first_collection';

class MemoryRepository {

  /**
   * 写入记忆：SQLite 先行 → Qdrant 异步同步
   */
  async save(userId, content, type = 'short', ttlSec = 7 * 86400) {
    const info = dbModule.saveMemory(userId, content, type, type === 'short' ? ttlSec : null);
    const id = info.lastInsertRowid;

    const synced = await this.syncOne(id);

    metrics.memoryWriteTotal.inc({ type, status: synced ? 'ok' : 'fail' });
    logger.info(`[MemoryRepo] 写入 id=${id} type=${type} sync=${synced ? '✅' : '❌'}`);

    return { id, synced };
  }

  /**
   * 同步单条记录到 Qdrant
   */
  async syncOne(id) {
    const row = dbModule.db.prepare('SELECT * FROM memory WHERE id=?').get(id);
    if (!row || row.sync_status === 'synced') return true;

    try {
      const res = await axios.post(`${VECTOR_API}/ingest`, {
        point_id: row.id,
        user_id: row.user_id,
        memory_type: row.memory_type,
        content: row.content,
      }, { timeout: 10000 });

      if (res.data.ok) {
        dbModule.updateSyncStatus(id, 'synced', row.id);
        return true;
      }
      throw new Error(res.data.detail || 'unknown');
    } catch (e) {
      dbModule.updateSyncStatus(id, 'failed');
      metrics.syncFailures.inc();
      logger.warn(`[MemoryRepo] 同步失败 id=${id}: ${e.message}`);
      return false;
    }
  }

  /**
   * 语义搜索（强制带 user_id 过滤 → 用户隔离）
   */
  async search(userId, query, { memoryType = null, topK = 5 } = {}) {
    const t0 = Date.now();
    try {
      const res = await axios.post(`${VECTOR_API}/search`, {
        query,
        user_id: userId,
        memory_type: memoryType,
        top_k: topK,
      }, { timeout: 15000 });

      const elapsed = (Date.now() - t0) / 1000;
      metrics.searchDuration.observe({ stage: 'total' }, elapsed);
      metrics.searchTotal.inc({ status: 'ok' });

      // 关联 SQLite 元数据
      const results = (res.data.results || []).map(hit => {
        const meta = dbModule.db.prepare(
          'SELECT memory_type, timestamp FROM memory WHERE id=?'
        ).get(hit.id);
        return { ...hit, meta };
      });

      return results;
    } catch (e) {
      metrics.searchTotal.inc({ status: 'error' });
      logger.error(`[MemoryRepo] 搜索失败: ${e.message}`);
      return [];
    }
  }

  /**
   * 组合检索：长期为主 + 短期补充
   */
  async recall(userId, query, topK = 5) {
    const [longHits, shortHits] = await Promise.all([
      this.search(userId, query, { memoryType: 'long', topK }),
      this.search(userId, query, { memoryType: 'short', topK: 3 }),
    ]);
    return { long: longHits, short: shortHits };
  }

  /**
   * 删除（短期记忆过期时调用）
   */
  async delete(id) {
    try {
      await axios.post(`${VECTOR_API}/delete`, {
        point_ids: [id]
      }, { timeout: 5000 });
    } catch (e) {
      logger.warn(`[MemoryRepo] Qdrant 删除失败 id=${id}: ${e.message}`);
    }
    dbModule.markExpired(id);
  }

  /**
   * 批量重试同步（由 worker 调用）
   */
  async retryPending() {
    const pending = dbModule.getPendingSync(50);
    let success = 0;
    for (const row of pending) {
      if (await this.syncOne(row.id)) success++;
    }
    if (pending.length > 0) {
      logger.info(`[MemoryRepo] 重试同步: ${success}/${pending.length} 成功`);
    }
    return { total: pending.length, success };
  }

  /**
   * 清理过期短期记忆（由 worker 调用）
   */
  async cleanExpired() {
    const expired = dbModule.getExpiredShortTerm(50);
    for (const row of expired) {
      await this.delete(row.id);
    }
    if (expired.length > 0) {
      logger.info(`[MemoryRepo] 清理过期记忆: ${expired.length} 条`);
    }
    return expired.length;
  }

  /**
   * 上报 Prometheus 指标（由 worker 定期调用）
   */
  reportMetrics() {
    const stats = dbModule.getStats();
    metrics.syncPending.set(stats.pending);
    metrics.memoryCount.set({ type: 'total' }, stats.total);
    for (const row of stats.byType) {
      metrics.memoryCount.set({ type: row.memory_type }, row.c);
    }
  }
}

module.exports = new MemoryRepository();
