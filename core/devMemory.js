// core/devMemory.js —— 开发知识库（L0 + L1 + 向量同步 + 埋点）
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const logger = require('../utils/logger');

const DB_FILE = path.join(__dirname, '../dev_knowledge.db');
const VECTOR_API = process.env.VECTOR_API_URL || 'http://127.0.0.1:8000';
const POINT_ID_OFFSET = 1_000_000_000;
const DEV_USER_ID = 'dev_me';
const DEV_MEMORY_TYPE = 'dev_experience';

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
  CREATE TABLE IF NOT EXISTS dev_search_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    query TEXT NOT NULL,
    query_norm TEXT,
    top_k INTEGER DEFAULT 3,
    hit_count INTEGER DEFAULT 0,
    hit_ids TEXT,
    top_score REAL,
    adopted_hit INTEGER DEFAULT 0,
    source TEXT DEFAULT 'dev',
    latency_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_distilled ON dev_events(distilled, ts);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON dev_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_task ON dev_events(task_type);
  CREATE INDEX IF NOT EXISTS idx_exp_task ON dev_experience(task_type, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_exp_vector ON dev_experience(vector_id);
  CREATE INDEX IF NOT EXISTS idx_exp_embedding ON dev_experience(embedding_status);
  CREATE INDEX IF NOT EXISTS idx_exp_adopted ON dev_experience(adopted, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_search_ts ON dev_search_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_search_query ON dev_search_log(query_norm);
  CREATE INDEX IF NOT EXISTS idx_search_hit ON dev_search_log(hit_count);
`);

const stmt = {
  insertEvent: db.prepare('INSERT INTO dev_events (ts, source, task_type, raw_input, raw_output, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getUndistilled: db.prepare('SELECT * FROM dev_events WHERE distilled = 0 AND unstructured = 0 ORDER BY ts ASC LIMIT ?'),
  markDistilled: db.prepare('UPDATE dev_events SET distilled = 1 WHERE id = ?'),
  markUnstructured: db.prepare('UPDATE dev_events SET unstructured = 1, distilled = -1 WHERE id = ?'),
  updateOutcome: db.prepare('UPDATE dev_events SET outcome = ? WHERE id = ?'),
  adoptEvent: db.prepare('UPDATE dev_events SET adopted = 1 WHERE id = ?'),
  getEventById: db.prepare('SELECT * FROM dev_events WHERE id = ?'),
  countEvents: db.prepare('SELECT COUNT(*) AS c FROM dev_events'),
  countDistilled: db.prepare('SELECT COUNT(*) AS c FROM dev_events WHERE distilled = 1'),
  countUnstructured: db.prepare('SELECT COUNT(*) AS c FROM dev_events WHERE unstructured = 1'),
  insertExperience: db.prepare('INSERT INTO dev_experience (ts, source_event_id, task_type, problem, solution, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getExperienceById: db.prepare('SELECT * FROM dev_experience WHERE id = ?'),
  updateEmbeddingStatus: db.prepare('UPDATE dev_experience SET embedding_status = ?, vector_id = ? WHERE id = ?'),
  adoptExperience: db.prepare('UPDATE dev_experience SET adopted = 1 WHERE id = ?'),
  countExperience: db.prepare('SELECT COUNT(*) AS c FROM dev_experience'),
  countEmbeddingPending: db.prepare("SELECT COUNT(*) AS c FROM dev_experience WHERE embedding_status = 'pending'"),
  searchFallbackNoType: db.prepare('SELECT * FROM dev_experience WHERE reusable = 1 ORDER BY adopted DESC, ts DESC LIMIT ?'),
  searchFallbackWithType: db.prepare('SELECT * FROM dev_experience WHERE reusable = 1 AND task_type = ? ORDER BY adopted DESC, ts DESC LIMIT ?'),
  insertSearchLog: db.prepare('INSERT INTO dev_search_log (ts, query, query_norm, top_k, hit_count, hit_ids, top_score, adopted_hit, source, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  countSearchLog: db.prepare('SELECT COUNT(*) AS c FROM dev_search_log'),
};

const txMarkDistilled = db.transaction((ids) => {
  for (const id of ids) stmt.markDistilled.run(id);
});
const txMarkUnstructured = db.transaction((ids) => {
  for (const id of ids) stmt.markUnstructured.run(id);
});

function rowToEvent(r) {
  if (!r) return null;
  return { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] };
}
function rowToExperience(r) {
  if (!r) return null;
  return { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] };
}

function normalizeQuery(q) {
  if (!q) return '';
  return String(q).toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, ' ').trim();
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
  const filesJson = Array.isArray(filesTouched) && filesTouched.length ? JSON.stringify(filesTouched) : null;
  const info = stmt.insertEvent.run(Date.now(), source, taskType, rawInput, rawOutput, filesJson, outcome);
  logger.info(`[DevMemory] L0 写入 id=${info.lastInsertRowid} source=${source} task=${taskType || '-'}`);
  return { id: info.lastInsertRowid };
}
function getUndistilled(limit) {
  limit = limit || 20;
  return stmt.getUndistilled.all(limit).map(rowToEvent);
}
function markDistilled(ids) {
  if (!ids || !ids.length) return;
  txMarkDistilled(ids);
  logger.info(`[DevMemory] 标记已蒸馏 ${ids.length} 条`);
}
function markUnstructured(ids) {
  if (!ids || !ids.length) return;
  txMarkUnstructured(ids);
  logger.warn(`[DevMemory] 降级 ${ids.length} 条`);
}
function updateEventOutcome(id, outcome) { stmt.updateOutcome.run(outcome, id); }
function adoptEvent(id) { stmt.adoptEvent.run(id); logger.info(`[DevMemory] 采纳 L0 id=${id}`); }
function getEventById(id) { return rowToEvent(stmt.getEventById.get(id)); }

// ==================== L1 ====================
function writeExperience(exp) {
  if (!exp || !exp.taskType || !exp.problem || !exp.solution) {
    throw new Error('[DevMemory] writeExperience 缺少必填字段 taskType/problem/solution');
  }
  const filesJson = Array.isArray(exp.filesTouched) && exp.filesTouched.length ? JSON.stringify(exp.filesTouched) : null;
  const info = stmt.insertExperience.run(
    Date.now(), exp.sourceEventId || null, exp.taskType, exp.problem, exp.solution, filesJson, exp.outcome || 'success'
  );
  logger.info(`[DevMemory] L1 写入 id=${info.lastInsertRowid} task=${exp.taskType}`);
  return { id: info.lastInsertRowid };
}
function getExperienceById(id) { return rowToExperience(stmt.getExperienceById.get(id)); }
function updateEmbeddingStatus(id, status, vectorId) {
  stmt.updateEmbeddingStatus.run(status, vectorId || null, id);
  logger.info(`[DevMemory] embedding 状态 id=${id} -> ${status}${vectorId ? ' vector_id=' + vectorId : ''}`);
}
function adoptExperience(id) { stmt.adoptExperience.run(id); logger.info(`[DevMemory] 采纳 L1 id=${id}`); }

// ==================== 向量同步 ====================
/**
 * 把一条 L1 同步到 p3-vector
 * point_id = POINT_ID_OFFSET + id
 */
async function syncExperienceToVector(id) {
  const row = getExperienceById(id);
  if (!row) {
    logger.warn(`[DevMemory] sync 跳过：L1 id=${id} 不存在`);
    return { ok: false, error: 'not found' };
  }
  const pointId = POINT_ID_OFFSET + id;
  const content = `${row.problem}\n${row.solution}`;
  try {
    const res = await axios.post(`${VECTOR_API}/ingest`, {
      point_id: pointId,
      user_id: DEV_USER_ID,
      memory_type: DEV_MEMORY_TYPE,
      content,
    }, { timeout: 10000 });

    if (res.data && res.data.ok === true) {
      updateEmbeddingStatus(id, 'done', String(pointId));
      return { ok: true, pointId };
    }
    throw new Error(JSON.stringify(res.data).slice(0, 200));
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    updateEmbeddingStatus(id, 'failed', null);
    logger.warn(`[DevMemory] sync 失败 id=${id}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ==================== 检索（向量优先 + SQLite 降级 + 埋点）====================
async function searchExperience(query, opts) {
  opts = opts || {};
  const topK = opts.topK || 3;
  const taskType = opts.taskType || null;
  const source = opts.source || 'dev';
  const t0 = Date.now();
  const searchTopK = taskType ? topK * 3 : topK;

  let hits = [];
  let vectorOk = false;
  let topScore = null;

  try {
    const res = await axios.post(`${VECTOR_API}/search`, {
      query,
      user_id: DEV_USER_ID,
      memory_type: DEV_MEMORY_TYPE,
      top_k: searchTopK,
    }, { timeout: 15000 });

    const results = res.data?.results || [];
    hits = results
      .map(r => {
        const l1Id = r.id - POINT_ID_OFFSET;
        const row = getExperienceById(l1Id);
        if (!row) return null;
        if (taskType && row.task_type !== taskType) return null;
        return { ...row, score: r.score };
      })
      .filter(Boolean)
      .slice(0, topK);

    if (hits.length > 0) topScore = hits[0].score;
    vectorOk = true;
  } catch (e) {
    logger.warn(`[DevMemory] 向量检索失败，降级 SQLite: ${e.message}`);
  }

  if (!vectorOk) {
    const rows = taskType
      ? stmt.searchFallbackWithType.all(taskType, topK)
      : stmt.searchFallbackNoType.all(topK);
    hits = rows.map(rowToExperience);
  }

  const latency = Date.now() - t0;

  try {
    stmt.insertSearchLog.run(
      Date.now(), String(query || ''), normalizeQuery(query),
      topK, hits.length, JSON.stringify(hits.map(h => h.id)),
      topScore, hits.some(h => h.adopted === 1) ? 1 : 0,
      source, latency
    );
  } catch (e) {
    logger.warn(`[DevMemory] search 埋点失败: ${e.message}`);
  }

  return hits;
}

// ==================== 统计 ====================
function stats() {
  return {
    events: stmt.countEvents.get().c,
    distilled: stmt.countDistilled.get().c,
    unstructured: stmt.countUnstructured.get().c,
    experience: stmt.countExperience.get().c,
    embedding_pending: stmt.countEmbeddingPending.get().c,
    search_log: stmt.countSearchLog.get().c,
  };
}
function selfCheck() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dev_%' ORDER BY name").all().map(r => r.name);
  return {
    db: DB_FILE,
    vector_api: VECTOR_API,
    point_id_offset: POINT_ID_OFFSET,
    journal_mode: db.pragma('journal_mode', { simple: true }),
    foreign_keys: db.pragma('foreign_keys', { simple: true }),
    tables,
    stats: stats(),
  };
}

module.exports = {
  writeEvent, getUndistilled, markDistilled, markUnstructured,
  updateEventOutcome, adoptEvent, getEventById,
  writeExperience, getExperienceById, updateEmbeddingStatus, adoptExperience,
  syncExperienceToVector, searchExperience,
  stats, selfCheck,
  _raw: db, _stmt: stmt,
};
