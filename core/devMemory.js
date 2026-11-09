const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_FILE = path.join(__dirname, '../dev_knowledge.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS dev_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT DEFAULT 'manual',
    project_name TEXT DEFAULT 'global', task_type TEXT, raw_input TEXT, raw_output TEXT, 
    files_touched TEXT, outcome TEXT DEFAULT 'pending', adopted INTEGER DEFAULT 0, 
    distilled INTEGER DEFAULT 0, unstructured INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dev_experience (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source_event_id INTEGER,
    project_name TEXT DEFAULT 'global', task_type TEXT NOT NULL, problem TEXT NOT NULL, 
    solution TEXT NOT NULL, files_touched TEXT, outcome TEXT DEFAULT 'success', 
    reusable INTEGER DEFAULT 1, adopted INTEGER DEFAULT 0, vector_id TEXT, 
    embedding_status TEXT DEFAULT 'pending', used_count INTEGER DEFAULT 0, 
    last_used_ts INTEGER, is_permanent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dev_sessions (
    user_id TEXT NOT NULL, project_name TEXT NOT NULL, last_code TEXT,
    is_active INTEGER DEFAULT 0, status TEXT DEFAULT 'active', updated_at INTEGER,
    PRIMARY KEY (user_id, project_name)
  );
  CREATE TABLE IF NOT EXISTS dev_project_context (
    user_id TEXT NOT NULL, project_name TEXT NOT NULL, context_md TEXT, updated_at INTEGER,
    PRIMARY KEY (user_id, project_name)
  );
`);

const stmt = {
  listGroups: db.prepare('SELECT group_name, COUNT(project_name) as project_count, MAX(updated_at) as last_active FROM dev_sessions WHERE user_id = ? GROUP BY group_name ORDER BY last_active DESC'),
  listProjectsInGroup: db.prepare('SELECT project_name, is_active, status, updated_at FROM dev_sessions WHERE user_id = ? AND group_name = ? ORDER BY updated_at DESC'),

  insertEvent: db.prepare('INSERT INTO dev_events (ts, source, group_name, project_name, task_type, raw_input, raw_output, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getUndistilled: db.prepare('SELECT * FROM dev_events WHERE distilled = 0 AND unstructured = 0 ORDER BY ts ASC LIMIT ?'),
  markDistilled: db.prepare('UPDATE dev_events SET distilled = 1 WHERE id = ?'),
  markUnstructured: db.prepare('UPDATE dev_events SET unstructured = 1, distilled = -1 WHERE id = ?'),
  
  insertExperience: db.prepare('INSERT INTO dev_experience (ts, source_event_id, group_name, project_name, task_type, problem, solution, files_touched, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getExperienceById: db.prepare('SELECT * FROM dev_experience WHERE id = ?'),
  updateEmbeddingStatus: db.prepare('UPDATE dev_experience SET embedding_status = ?, vector_id = ? WHERE id = ?'),
  
  getActiveSession: db.prepare('SELECT * FROM dev_sessions WHERE user_id = ? AND is_active = 1'),
  switchProject: db.prepare('UPDATE dev_sessions SET is_active = 0 WHERE user_id = ?'),
  createSession: db.prepare('INSERT OR REPLACE INTO dev_sessions (user_id, project_name, last_code, is_active, status, updated_at) VALUES (?, ?, ?, 1, \'active\', ?)'),
  updateSessionCode: db.prepare('UPDATE dev_sessions SET last_code = ?, updated_at = ? WHERE user_id = ? AND project_name = ?'),
  listSessions: db.prepare('SELECT project_name, is_active, status, updated_at FROM dev_sessions WHERE user_id = ? ORDER BY updated_at DESC'),
  markProjectDone: db.prepare("UPDATE dev_sessions SET status = 'completed', last_code = NULL, is_active = 0, updated_at = ? WHERE user_id = ? AND project_name = ?"),
  
  setProjectContext: db.prepare('INSERT OR REPLACE INTO dev_project_context (user_id, project_name, context_md, updated_at) VALUES (?, ?, ?, ?)'),
  getProjectContext: db.prepare('SELECT context_md FROM dev_project_context WHERE user_id = ? AND project_name = ?'),
};

function rowToEvent(r) { return r ? { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] } : null; }
function rowToExperience(r) { return r ? { ...r, files_touched: r.files_touched ? JSON.parse(r.files_touched) : [] } : null; }

// L0
function writeEvent(ev) {
  const info = stmt.insertEvent.run(Date.now(), ev.source || 'manual', ev.groupName || 'common', ev.projectName || 'global', ev.taskType || null, ev.rawInput || null, ev.rawOutput || null, ev.filesTouched ? JSON.stringify(ev.filesTouched) : null, ev.outcome || 'pending');
  return { id: info.lastInsertRowid };
}
function getUndistilled(limit) { return stmt.getUndistilled.all(limit).map(rowToEvent); }
function markDistilled(ids) { for (const id of ids) stmt.markDistilled.run(id); }
function markUnstructured(ids) { for (const id of ids) stmt.markUnstructured.run(id); }

// L1
function writeExperience(exp) {
  const info = stmt.insertExperience.run(Date.now(), exp.sourceEventId, exp.groupName || 'common', exp.projectName || 'global', exp.taskType, exp.problem, exp.solution, exp.filesTouched ? JSON.stringify(exp.filesTouched) : null, exp.outcome);
  return { id: info.lastInsertRowid };
}
function getExperienceById(id) { return rowToExperience(stmt.getExperienceById.get(id)); }
function updateEmbeddingStatus(id, status, vectorId) { stmt.updateEmbeddingStatus.run(status, vectorId, id); }

// Sessions & 宪法
function switchProjectWorkspace(userId, rawProjectName) {
  let groupName = 'common';
  let projectName = rawProjectName;
  if (rawProjectName.includes('/')) {
    const parts = rawProjectName.split('/');
    groupName = parts[0].trim();
    projectName = parts[1].trim();
  }
  db.transaction(() => {
    stmt.switchProject.run(userId);
    // 更新 createSession 的 SQL 需要包含 group_name
    db.prepare("INSERT OR REPLACE INTO dev_sessions (user_id, group_name, project_name, last_code, is_active, status, updated_at) VALUES (?, ?, ?, '', 1, 'active', ?)").run(userId, groupName, projectName, Date.now());
  })();
  logger.info(`[DevMemory] 用户切换至项目组: ${groupName} | 项目: ${projectName}`);
}
function getActiveSession(userId) { return stmt.getActiveSession.get(userId); }
function updateSessionCode(userId, projectName, code) { stmt.updateSessionCode.run(code, Date.now(), userId, projectName); }
function listUserProjects(userId) { return stmt.listSessions.all(userId); }
function markProjectDone(userId, projectName) { stmt.markProjectDone.run(Date.now(), userId, projectName); }
function updateProjectContext(userId, projectName, ctx) { stmt.setProjectContext.run(userId, projectName, ctx, Date.now()); }
function getProjectContext(userId, projectName) { const r = stmt.getProjectContext.get(userId, projectName); return r ? r.context_md : null; }


// 🆕 项目组查询
function listUserGroups(userId) {
  return stmt.listGroups.all(userId);
}

function listProjectsInGroup(userId, groupName) {
  return stmt.listProjectsInGroup.all(userId, groupName);
}

module.exports = {
  writeEvent, getUndistilled, markDistilled, markUnstructured,
  writeExperience, getExperienceById, updateEmbeddingStatus,
  switchProjectWorkspace, getActiveSession, updateSessionCode, listUserProjects, markProjectDone,
  updateProjectContext, getProjectContext, listUserGroups, listProjectsInGroup, _raw: db, _stmt: stmt
};
