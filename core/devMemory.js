// core/devMemory.js —— 开发知识库（L0 原始事件 + L1 结构化经验）
// 独立连接 dev_knowledge.db，与 chat_memory.db / maid_memory.db 零耦合
const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_FILE = path.join(__dirname, '../dev_knowledge.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS dev_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    task_type TEXT,
    raw_input TEXT,
    raw_output TEXT,
    files_touched TEXT,
    outcome TEXT DEFAULT 'pending',
    adopted INTEGER DEFAULT 0,
    distilled INTEGER DEFAULT 0,
    unstructured INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dev_experience (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source_event_id INTEGER,
    task_type TEXT NOT NULL,
    problem TEXT NOT NULL,
    solution TEXT NOT NULL,
    files_touched TEXT,
    outcome TEXT DEFAULT 'success',
    reusable INTEGER DEFAULT 1,
    adopted INTEGER DEFAULT 0,
    vector_id TEXT,
    embedding_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (source_event_id) REFERENCES dev_events(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS dev_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    pattern TEXT NOT NULL,
    evidence_ids TEXT,
    confidence REAL DEFAULT 0.0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_distilled ON dev_events(distilled, ts);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON dev_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_task ON dev_events(task_type);
  CREATE INDEX IF NOT EXISTS idx_exp_task ON dev_experience(task_type, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_exp_vector ON dev_experience(vector_id);
  CREATE INDEX IF NOT EXISTS idx_exp_embedding ON dev_experience(embedding_status);
  CREATE INDEX IF NOT EXISTS idx_exp_adopted ON dev_experience(adopted, ts DESC);
`);

// ===== 预编译语句 =====
const stmt = {
  // L0
  insertEvent: db.prepare(
    'INSERT INTO dev_events (ts, source, task_type, raw_input, raw_output, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  getUndistilled: db.prepare(
    'SELECT * FROM dev_events WHERE distilled = 0 AND unstructured = 0 ORDER BY ts ASC LIMIT ?'
  ),
  markDistilled: db.prepare('UPDATE dev_events SET distilled = 1 WHERE id = ?'),
  markUnstructured: db.prepare('UPDATE dev_events SET unstructured = 1, distilled = -1 WHERE id = ?'),
  updateOutcome: db.prepare('UPDATE dev_events SET outcome = ? WHERE id = ?'),
  adoptEvent: db.prepare('UPDATE dev_events SET adopted = 1 WHERE id = ?'),
  getEventById: db.prepare('SELECT * FROM dev_events WHERE id = ?'),
  countEvents: db.prepare('SELECT COUNT(*) AS c FROM dev_events'),
  countDistilled: db.prepare('SELECT COUNT(*) AS c FROM dev_events WHERE distilled = 1'),
  countUnstructured: db.prepare('SELECT COUNT(*) AS c FROM dev_events WHERE unstructured = 1'),

  // L1
  insertExperience: db.prepare(
    'INSERT INTO dev_experience (ts, source_event_id, task_type, problem, solution, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  getExperienceById: db.prepare('SELECT * FROM dev_experience WHERE id = ?'),
  updateEmbeddingStatus: db.prepare(
    'UPDATE dev_experience SET embedding_status = ?, vector_id = ? WHERE id = ?'
  ),
  adoptExperience: db.prepare('UPDATE dev_experience SET adopted = 1 WHERE id = ?'),
  countExperience: db.prepare('SELECT COUNT(*) AS c FROM dev_experience'),
  countEmbeddingPending: db.prepare(
    "SELECT COUNT(*) AS c FROM dev_experience WHERE embedding_status = 'pending'"
  ),
  // searchExperience 的 fallback SQL（周四换向量后保留为兜底）
  searchFallbackNoType: db.prepare(
    'SELECT * FROM dev_experience WHERE reusable = 1 ORDER BY adopted DESC, ts DESC LIMIT ?'
  ),
  searchFallbackWithType: db.prepare(
    'SELECT * FROM dev_experience WHERE reusable = 1 AND task_type = ? ORDER BY adopted DESC, ts DESC LIMIT ?'
  ),
};

// ===== 事务 =====
const txMarkDistilled = db.transaction((ids) => {
  for (const id of ids) stmt.markDistilled.run(id);
});
const txMarkUnstructured = db.transaction((ids) => {
  for (const id of ids) stmt.markUnstructured.run(id);
});

// ===== 行反序列化 =====
function rowToEvent(r) {
  if (!r) return null;
  return { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] };
}
function rowToExperience(r) {
  if (!r) return null;
  return { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] };
}

// ==================== L0 ====================

function writeEvent(ev) {
  ev = ev || {};
  const source = ev.source || 'manual';
  const taskType = ev.taskType || null;
  const rawInput = ev.rawInput || null;
  const rawOutput = ev.rawOutput || null;
  const filesTouched = ev.filesTouched || [];
  const outcome = ev.outcome || 'pending';

  const filesJson = Array.isArray(filesTouched) && filesTouched.length
    ? JSON.stringify(filesTouched)
    : null;

  const info = stmt.insertEvent.run(Date.now(), source, taskType, rawInput, rawOutput, filesJson, outcome);
  logger.info(`[DevMemory] L0 写入 id=${info.lastInsertRowid} source=${source} task=${taskType || '-'}`);
  return { id: info.lastInsertRowid };
}

function getUndistilled(limit) {
  limit = limit || 20;
  const rows = stmt.getUndistilled.all(limit);
  return rows.map(rowToEvent);
}

function markDistilled(ids) {
  if (ids === undefined || ids === null || ids.length === 0) return;
  txMarkDistilled(ids);
  logger.info(`[DevMemory] 标记已蒸馏 ${ids.length} 条: ${ids.join(',')}`);
}

function markUnstructured(ids) {
  if (ids === undefined || ids === null || ids.length === 0) return;
  txMarkUnstructured(ids);
  logger.warn(`[DevMemory] 降级 ${ids.length} 条: ${ids.join(',')}`);
}

function updateEventOutcome(id, outcome) {
  stmt.updateOutcome.run(outcome, id);
}

function adoptEvent(id) {
  stmt.adoptEvent.run(id);
  logger.info(`[DevMemory] 采纳 L0 id=${id}`);
}

function getEventById(id) {
  return rowToEvent(stmt.getEventById.get(id));
}

// ==================== L1 ====================

/**
 * 写入 L1 结构化经验
 * @param {object} exp
 * @param {number} [exp.sourceEventId]  关联的 L0 id
 * @param {string} exp.taskType
 * @param {string} exp.problem
 * @param {string} exp.solution
 * @param {string[]} [exp.filesTouched]
 * @param {string} [exp.outcome='success']
 */
function writeExperience(exp) {
  if (!exp || !exp.taskType || !exp.problem || !exp.solution) {
    throw new Error('[DevMemory] writeExperience 缺少必填字段 taskType/problem/solution');
  }
  const filesJson = Array.isArray(exp.filesTouched) && exp.filesTouched.length
    ? JSON.stringify(exp.filesTouched)
    : null;
  const info = stmt.insertExperience.run(
    Date.now(),
    exp.sourceEventId || null,
    exp.taskType,
    exp.problem,
    exp.solution,
    filesJson,
    exp.outcome || 'success'
  );
  logger.info(`[DevMemory] L1 写入 id=${info.lastInsertRowid} task=${exp.taskType}`);
  return { id: info.lastInsertRowid };
}

function getExperienceById(id) {
  return rowToExperience(stmt.getExperienceById.get(id));
}

function updateEmbeddingStatus(id, status, vectorId) {
  stmt.updateEmbeddingStatus.run(status, vectorId || null, id);
  logger.info(`[DevMemory] embedding 状态 id=${id} -> ${status}${vectorId ? ' vector_id=' + vectorId : ''}`);
}

function adoptExperience(id) {
  stmt.adoptExperience.run(id);
  logger.info(`[DevMemory] 采纳 L1 id=${id}`);
}

/**
 * 语义检索 —— 明天先用 SQLite fallback，周四换成 p3-vector
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.topK=3]
 * @param {string} [opts.taskType=null]
 * @returns {Array<object>}
 */
function searchExperience(query, opts) {
  opts = opts || {};
  const topK = opts.topK || 3;
  const taskType = opts.taskType || null;

  // TODO(W2 周四): 替换为 p3-vector /search 调用
  //   约定: user_id='dev_me', memory_type='dev_experience', point_id='dev_exp_<id>'
  // fallback: 按 task_type 过滤 + adopted/ts 排序
  const rows = taskType
    ? stmt.searchFallbackWithType.all(taskType, topK)
    : stmt.searchFallbackNoType.all(topK);
  return rows.map(rowToExperience);
}

// ==================== 统计 / 自检 ====================

function stats() {
  return {
    events: stmt.countEvents.get().c,
    distilled: stmt.countDistilled.get().c,
    unstructured: stmt.countUnstructured.get().c,
    experience: stmt.countExperience.get().c,
    embedding_pending: stmt.countEmbeddingPending.get().c,
  };
}

function selfCheck() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dev_%' ORDER BY name"
  ).all().map(r => r.name);
  return {
    db: DB_FILE,
    journal_mode: db.pragma('journal_mode', { simple: true }),
    foreign_keys: db.pragma('foreign_keys', { simple: true }),
    tables,
    stats: stats(),
  };
}

module.exports = {
  // L0
  writeEvent,
  getUndistilled,
  markDistilled,
  markUnstructured,
  updateEventOutcome,
  adoptEvent,
  getEventById,
  // L1
  writeExperience,
  getExperienceById,
  updateEmbeddingStatus,
  adoptExperience,
  searchExperience,
  // 统计
  stats,
  selfCheck,
  // 调试
  _raw: db,
  _stmt: stmt,
};
