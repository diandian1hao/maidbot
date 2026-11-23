const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const logger = require('../utils/logger');

const DB_FILE = path.join(__dirname, '../dev_knowledge.db');
const VECTOR_API = process.env.VECTOR_API_URL || 'http://127.0.0.1:8000';

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// 已移除不稳定的内存缓存
db.exec(`
  CREATE TABLE IF NOT EXISTS dev_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT DEFAULT 'manual',
    group_name TEXT DEFAULT 'common', project_name TEXT DEFAULT 'global', task_type TEXT, raw_input TEXT, raw_output TEXT, 
    files_touched TEXT, outcome TEXT DEFAULT 'pending', adopted INTEGER DEFAULT 0, 
    distilled INTEGER DEFAULT 0, unstructured INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dev_experience (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source_event_id INTEGER,
    group_name TEXT DEFAULT 'common', project_name TEXT DEFAULT 'global', task_type TEXT NOT NULL, problem TEXT NOT NULL, 
    solution TEXT NOT NULL, files_touched TEXT, outcome TEXT DEFAULT 'success', audit_status TEXT DEFAULT 'pending', review_comments TEXT, 
    reusable INTEGER DEFAULT 1, adopted INTEGER DEFAULT 0, vector_id TEXT, 
    embedding_status TEXT DEFAULT 'pending', used_count INTEGER DEFAULT 0, 
    last_used_ts INTEGER, is_permanent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dev_sessions (
    user_id TEXT NOT NULL, group_name TEXT DEFAULT 'common', project_name TEXT NOT NULL, last_code TEXT,
    is_active INTEGER DEFAULT 0, status TEXT DEFAULT 'active', updated_at INTEGER,
    PRIMARY KEY (user_id, group_name, project_name)
  );
  CREATE TABLE IF NOT EXISTS dev_project_context (
    user_id TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT 'common', project_name TEXT NOT NULL, context_md TEXT, updated_at INTEGER,
    PRIMARY KEY (user_id, group_name, project_name)
  );
  CREATE TABLE IF NOT EXISTS dev_search_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, query TEXT, hit_count INTEGER, latency_ms INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS dev_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, pattern TEXT NOT NULL, 
    evidence_ids TEXT, confidence REAL, created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS dev_experience_fts USING fts5(
    problem, solution, content='dev_experience', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS dev_exp_ai AFTER INSERT ON dev_experience BEGIN
    INSERT INTO dev_experience_fts(rowid, problem, solution) VALUES (new.id, new.problem, new.solution);
  END;
  CREATE TRIGGER IF NOT EXISTS dev_exp_ad AFTER DELETE ON dev_experience BEGIN
    INSERT INTO dev_experience_fts(dev_experience_fts, rowid, problem, solution) VALUES('delete', old.id, old.problem, old.solution);
  END;
`);


  db.exec("CREATE TABLE IF NOT EXISTS dev_snapshot(user_id TEXT NOT NULL, group_name TEXT NOT NULL, project_name TEXT NOT NULL, snapshot_json TEXT DEFAULT '{}', updated_at INTEGER, PRIMARY KEY(user_id, group_name, project_name))");
  db.exec("CREATE TABLE IF NOT EXISTS dev_constitution_history(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, group_name TEXT, project_name TEXT, old_text TEXT, new_text TEXT, change_reason TEXT, created_at TEXT DEFAULT(datetime('now','localtime')))");
const stmt = {
  insertEvent: db.prepare('INSERT INTO dev_events (ts, source, group_name, project_name, task_type, raw_input, raw_output, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getUndistilled: db.prepare('SELECT * FROM dev_events WHERE distilled = 0 AND unstructured = 0 ORDER BY ts ASC LIMIT ?'),
  markDistilled: db.prepare('UPDATE dev_events SET distilled = 1 WHERE id = ?'),
  markUnstructured: db.prepare('UPDATE dev_events SET unstructured = 1, distilled = -1 WHERE id = ?'),
  insertExperience: db.prepare('INSERT INTO dev_experience (ts, source_event_id, group_name, project_name, task_type, problem, solution, files_touched, outcome, audit_status, review_comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getExperienceById: db.prepare('SELECT * FROM dev_experience WHERE id = ?'),
  updateEmbeddingStatus: db.prepare('UPDATE dev_experience SET embedding_status = ?, vector_id = ? WHERE id = ?'),
  
  getActiveSession: db.prepare("SELECT * FROM dev_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1"),
  switchProject: db.prepare('UPDATE dev_sessions SET is_active = 0 WHERE user_id = ?'),
  listSessions: db.prepare('SELECT project_name, group_name, is_active, status, updated_at, length(last_code) as code_len FROM dev_sessions WHERE user_id = ? ORDER BY updated_at DESC'),
  updateSessionCode: db.prepare('UPDATE dev_sessions SET last_code = ?, updated_at = ? WHERE user_id = ? AND group_name = ? AND project_name = ?'),
  markDone: db.prepare("UPDATE dev_sessions SET status = 'completed', last_code = NULL, is_active = 0, updated_at = ? WHERE user_id = ? AND group_name = ? AND project_name = ?")
};

function rowToEvent(r) { return r ? { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] } : null; }
function rowToExperience(r) { return r ? { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] } : null; }

function writeEvent(ev) {
  const info = stmt.insertEvent.run(Date.now(), ev.source || 'manual', ev.groupName || 'common', ev.projectName || 'global', ev.taskType || null, ev.rawInput || null, ev.rawOutput || null, ev.filesTouched ? JSON.stringify(ev.filesTouched) : null, ev.outcome || 'pending');
  return { id: info.lastInsertRowid };
}

function getUndistilled(limit) { return stmt.getUndistilled.all(limit).map(rowToEvent); }
function markDistilled(ids) { for (const id of ids) stmt.markDistilled.run(id); }
function markUnstructured(ids) { for (const id of ids) stmt.markUnstructured.run(id); }

function writeExperience(exp) {
  const info = stmt.insertExperience.run(Date.now(), exp.sourceEventId, exp.groupName || 'common', exp.projectName || 'global', exp.taskType, exp.problem, exp.solution, exp.filesTouched ? JSON.stringify(exp.filesTouched) : null, exp.outcome, exp.auditStatus || 'pending', exp.reviewComments || null);
  return { id: info.lastInsertRowid };
}
function getExperienceById(id) { return rowToExperience(stmt.getExperienceById.get(id)); }
function updateEmbeddingStatus(id, status, vectorId) { stmt.updateEmbeddingStatus.run(status, vectorId, id); }

async function syncExperienceToVector(id) {
  const row = getExperienceById(id);
  if (!row) return;
  const pointId = 1_000_000_000 + id;
  const content = `${row.problem}\n${row.solution}`;
  try {
    const res = await axios.post(`${VECTOR_API}/ingest`, { point_id: pointId, user_id: 'dev_me', memory_type: 'dev_experience', content: content }, { timeout: 10000 });
    if (res.data && res.data.ok) updateEmbeddingStatus(id, 'done', String(pointId));
    else throw new Error('ingest failed');
  } catch (e) { updateEmbeddingStatus(id, 'failed', null); }
}

function getProjectContext(userId, groupName, projectName) { 
  if (!userId || !groupName || !projectName) return null;
  const r = db.prepare('SELECT context_md FROM dev_project_context WHERE user_id = ? AND group_name = ? AND project_name = ?').get(userId, groupName, projectName); 
  return r ? r.context_md : null; 
}

function updateProjectContext(userId, groupName, projectName, ctx) { 
  if (!userId || !groupName || !projectName || typeof ctx !== 'string') return false;
  db.prepare('INSERT OR REPLACE INTO dev_project_context (user_id, group_name, project_name, context_md, updated_at) VALUES (?, ?, ?, ?, ?)').run(userId, groupName, projectName, ctx, Date.now()); 
  return true;
}

function switchProjectWorkspace(userId, rawProjectName) {
  let groupName = 'common';
  let projectName = rawProjectName || 'global';
  if (rawProjectName && typeof rawProjectName === 'string' && rawProjectName.includes('/')) {
    const parts = rawProjectName.split('/');
    groupName = parts[0].trim() || 'common';
    projectName = parts[1].trim() || 'global';
  }

  db.transaction(() => {
    stmt.switchProject.run(userId); // 清理所有的 active
    const exist = db.prepare('SELECT 1 FROM dev_sessions WHERE user_id = ? AND group_name = ? AND project_name = ?').get(userId, groupName, projectName);
    if (exist) {
      db.prepare('UPDATE dev_sessions SET is_active = 1, updated_at = ? WHERE user_id = ? AND group_name = ? AND project_name = ?')
        .run(Date.now(), userId, groupName, projectName);
    } else {
      db.prepare("INSERT INTO dev_sessions (user_id, group_name, project_name, last_code, is_active, status, updated_at) VALUES (?, ?, ?, '', 1, 'active', ?)")
        .run(userId, groupName, projectName, Date.now());
    }
  })();
  logger.info(`[DevMemory] 用户切换至项目组: ${groupName} | 项目: ${projectName}`);
}

function getActiveSession(userId) { return stmt.getActiveSession.get(userId); }
function listUserProjects(userId) { return stmt.listSessions.all(userId); }

function updateSessionCode(userId, projectName, code) {
  const active = getActiveSession(userId);
  if (active && active.project_name === projectName) {
    stmt.updateSessionCode.run(code, Date.now(), userId, active.group_name, projectName);
  }
}

function markProjectDone(userId, projectName) {
  const active = getActiveSession(userId);
  if (active && active.project_name === projectName) {
    db.transaction(() => {
      stmt.markDone.run(Date.now(), userId, active.group_name, projectName);
      db.prepare('UPDATE dev_experience SET is_permanent = 1 WHERE group_name = ? AND project_name = ?').run(active.group_name, projectName);
    })();
  }
}

function moveProjectToGroup(userId, oldGroup, projectName, newGroup) {
  db.prepare('UPDATE dev_sessions SET group_name = ? WHERE user_id = ? AND group_name = ? AND project_name = ?').run(newGroup, userId, oldGroup, projectName);
}

async function deleteProject(userId, groupName, projectName) {
  db.transaction(() => {
    db.prepare('DELETE FROM dev_events WHERE group_name = ? AND project_name = ?').run(groupName, projectName);
    db.prepare('DELETE FROM dev_experience WHERE group_name = ? AND project_name = ?').run(groupName, projectName);
    db.prepare('DELETE FROM dev_sessions WHERE user_id = ? AND group_name = ? AND project_name = ?').run(userId, groupName, projectName);
    db.prepare('DELETE FROM dev_project_context WHERE user_id = ? AND group_name = ? AND project_name = ?').run(userId, groupName, projectName);
  })();
}

async function deleteGroup(userId, groupName) {
  db.transaction(() => {
    db.prepare('DELETE FROM dev_events WHERE group_name = ?').run(groupName);
    db.prepare('DELETE FROM dev_experience WHERE group_name = ?').run(groupName);
    db.prepare('DELETE FROM dev_sessions WHERE user_id = ? AND group_name = ?').run(userId, groupName);
    db.prepare('DELETE FROM dev_project_context WHERE user_id = ? AND group_name = ?').run(userId, groupName);
  })();
}

function stats() {
  return {
    events: db.prepare('SELECT COUNT(*) AS c FROM dev_events').get().c,
    distilled: db.prepare('SELECT COUNT(*) AS c FROM dev_events WHERE distilled = 1').get().c,
    unstructured: db.prepare('SELECT COUNT(*) AS c FROM dev_events WHERE unstructured = 1').get().c,
    experience: db.prepare('SELECT COUNT(*) AS c FROM dev_experience').get().c,
    embedding_pending: db.prepare("SELECT COUNT(*) AS c FROM dev_experience WHERE embedding_status = 'pending'").get().c,
    search_log: db.prepare('SELECT COUNT(*) AS c FROM dev_search_log').get().c,
  };
}

module.exports = {
  writeEvent, getUndistilled, markDistilled, markUnstructured,
  writeExperience, getExperienceById, updateEmbeddingStatus, syncExperienceToVector,
  switchProjectWorkspace, getActiveSession, updateSessionCode, listUserProjects, markProjectDone,
  updateProjectContext, getProjectContext,
  deleteProject, deleteGroup, moveProjectToGroup, 
  stats, _raw: db, _stmt: stmt
};
