// core/memory.js —— 女仆的记忆海马体 💾 (better-sqlite3)
// ✅ P1: 写入去重 + TTL 过期 + 定期清理
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_FILE = path.join(__dirname, '../chat_memory.db');
const CAP = 20;
const KEEP = 10;
const DEDUP_WINDOW = 5;
const TTL_DAYS = 30;

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ====== 第一步：确保表存在（不含新列）======
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_summary (
    user_id    TEXT PRIMARY KEY,
    summary    TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ====== 第二步：兼容旧数据，补列（已存在则忽略）======
try { db.exec("ALTER TABLE messages ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN expires_at DATETIME DEFAULT NULL"); } catch {}

// ====== 第三步：列已存在，现在才能建索引 ======
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at);
`);

// 回填旧数据的 hash
const needHash = db.prepare("SELECT id, content FROM messages WHERE content_hash = ''").all();
if (needHash.length) {
  const fillHash = db.prepare("UPDATE messages SET content_hash = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of needHash) {
      fillHash.run(crypto.createHash('md5').update(r.content).digest('hex'), r.id);
    }
  });
  tx();
  console.log(`[Memory] 🔧 已回填 ${needHash.length} 条旧数据的 hash`);
}

// ====== 预编译语句 ======
const stmt = {
  getHistory: db.prepare(`
    SELECT role, content FROM messages
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `),
  append: db.prepare(`
    INSERT INTO messages (user_id, role, content, content_hash, expires_at)
    VALUES (?, ?, ?, ?, CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' days') ELSE NULL END)
  `),
  recentHashes: db.prepare(`
    SELECT content_hash FROM messages
    WHERE user_id = ? AND role = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `),
  getEvictable: db.prepare(`
    SELECT role, content FROM messages
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at ASC, id ASC
  `),
  countAll: db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `),
  deleteOld: db.prepare(`
    DELETE FROM messages
    WHERE user_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `),
  purgeExpired: db.prepare(`
    DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')
  `),
  getSum: db.prepare(`SELECT summary FROM user_summary WHERE user_id = ?`),
  upsertSum: db.prepare(`
    INSERT INTO user_summary (user_id, summary, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET summary = excluded.summary, updated_at = CURRENT_TIMESTAMP
  `),
  clearMsg: db.prepare(`DELETE FROM messages WHERE user_id = ?`),
  clearSum: db.prepare(`DELETE FROM user_summary WHERE user_id = ?`),
};

function loadHistory(userId) {
  return stmt.getHistory.all(userId, CAP).reverse();
}

function _contentHash(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

// ====== 对外 API ======
module.exports = {
  getHistory(userId) { return loadHistory(userId); },

  getSummary(userId) {
    const row = stmt.getSum.get(userId);
    return row?.summary || '';
  },

  append(userId, role, content) {
    const hash = _contentHash(content);
    const recent = stmt.recentHashes.all(userId, role, DEDUP_WINDOW);
    if (recent.some(r => r.content_hash === hash)) {
      console.log(`[Memory] ⏭️ 去重跳过: ${role} "${content.slice(0, 20)}..."`);
      return null;
    }
    stmt.append.run(userId, role, content, hash, TTL_DAYS, TTL_DAYS);
    const total = stmt.countAll.get(userId).n;
    if (total > CAP) {
      const all = stmt.getEvictable.all(userId);
      const evicted = all.slice(0, all.length - KEEP);
      return evicted.length ? evicted : null;
    }
    return null;
  },

  pruneAfterSummary(userId) { stmt.deleteOld.run(userId, userId, KEEP); },
  setSummary(userId, summary) { stmt.upsertSum.run(userId, summary); },
  clear(userId) { stmt.clearMsg.run(userId); stmt.clearSum.run(userId); },

  purgeExpired() {
    const info = stmt.purgeExpired.run();
    if (info.changes > 0) console.log(`[Memory] 🗑️ 已清理 ${info.changes} 条过期记忆`);
    return info.changes;
  },

  countUsers() {
    return db.prepare('SELECT COUNT(DISTINCT user_id) FROM messages').get()[0];
  },

  _raw: db,
};

// 内置过期清理定时器（每6小时）
setInterval(() => {
  try { module.exports.purgeExpired(); } catch (e) {
    console.error('[Memory] ⚠️ 过期清理失败:', e.message);
  }
}, 6 * 3600 * 1000).unref?.();
