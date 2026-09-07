const Database = require('better-sqlite3');
const path = require('path');

// 初始化数据库连接
const db = new Database(path.join(__dirname, '../maid_memory.db'));

// P0: WAL 模式 + 繁忙超时
db.pragma('journal_mode = WAL', { simple: true });
db.pragma('busy_timeout = 5000');

// ====== 升级表结构：兼容旧数据 ======
db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 安全添加新列（如果不存在）
const columns = db.prepare("PRAGMA table_info(memory)").all().map(c => c.name);

if (!columns.includes('memory_type')) {
  db.exec("ALTER TABLE memory ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'short'");
}
if (!columns.includes('qdrant_id')) {
  db.exec("ALTER TABLE memory ADD COLUMN qdrant_id INTEGER");
}
if (!columns.includes('sync_status')) {
  db.exec("ALTER TABLE memory ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'");
}
if (!columns.includes('expires_at')) {
  db.exec("ALTER TABLE memory ADD COLUMN expires_at INTEGER");
}

// 索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_mem_user   ON memory(user_id, memory_type);
  CREATE INDEX IF NOT EXISTS idx_mem_sync   ON memory(sync_status);
  CREATE INDEX IF NOT EXISTS idx_mem_expire ON memory(expires_at);
`);

module.exports = {
  db,  // ⭐ 导出原始实例，供 memory.js / gracefulShutdown 使用

  // 保存记忆（升级版）
  saveMemory(userId, content, memoryType = 'short', ttlSec = null) {
    const expiresAt = (memoryType === 'short' && ttlSec)
      ? Math.floor(Date.now() / 1000) + ttlSec
      : null;
    const stmt = db.prepare(
      `INSERT INTO memory (user_id, content, memory_type, sync_status, expires_at)
       VALUES (?, ?, ?, 'pending', ?)`
    );
    return stmt.run(userId, content, memoryType, expiresAt);
  },

  // 获取最近记忆（带类型过滤）
  getRecentMemories(userId, limit = 10, memoryType = null) {
    if (memoryType) {
      return db.prepare(
        `SELECT * FROM memory WHERE user_id=? AND memory_type=? AND sync_status='synced'
         ORDER BY timestamp DESC LIMIT ?`
      ).all(userId, memoryType, limit);
    }
    return db.prepare(
      `SELECT * FROM memory WHERE user_id=? AND sync_status='synced'
       ORDER BY timestamp DESC LIMIT ?`
    ).all(userId, limit);
  },

  // 获取待同步记录
  getPendingSync(limit = 50) {
    return db.prepare(
      `SELECT * FROM memory WHERE sync_status IN ('pending','failed') LIMIT ?`
    ).all(limit);
  },

  // 更新同步状态
  updateSyncStatus(id, status, qdrantId = null) {
    if (qdrantId !== null) {
      db.prepare(`UPDATE memory SET sync_status=?, qdrant_id=? WHERE id=?`).run(status, qdrantId, id);
    } else {
      db.prepare(`UPDATE memory SET sync_status=? WHERE id=?`).run(status, id);
    }
  },

  // 获取过期短期记忆
  getExpiredShortTerm(limit = 50) {
    const now = Math.floor(Date.now() / 1000);
    return db.prepare(
      `SELECT * FROM memory WHERE memory_type='short' AND expires_at < ?
       AND sync_status='synced' LIMIT ?`
    ).all(now, limit);
  },

  // 标记为过期
  markExpired(id) {
    db.prepare(`UPDATE memory SET sync_status='expired' WHERE id=?`).run(id);
  },

  // 统计
  getStats() {
    const total = db.prepare(`SELECT COUNT(*) c FROM memory`).get().c;
    const byType = db.prepare(
      `SELECT memory_type, COUNT(*) c FROM memory GROUP BY memory_type`
    ).all();
    const pending = db.prepare(
      `SELECT COUNT(*) c FROM memory WHERE sync_status IN ('pending','failed')`
    ).get().c;
    return { total, byType, pending };
  }
};
