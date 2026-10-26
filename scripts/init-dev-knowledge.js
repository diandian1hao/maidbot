// scripts/init-dev-knowledge.js
// 一键初始化 dev_knowledge.db：建表 + 建索引 + 自检
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'dev_knowledge.db');

const SCHEMA = `
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
`;

function main() {
  console.log('=== 初始化 dev_knowledge.db ===');
  console.log('路径:', DB_PATH);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(SCHEMA);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dev_%' ORDER BY name"
  ).all();
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
  ).all();

  console.log('\n=== 表 ===');
  tables.forEach(t => console.log('  OK', t.name));

  console.log('\n=== 索引 ===');
  indexes.forEach(i => console.log('  OK', i.name));

  const wal = db.pragma('journal_mode', { simple: true });
  const fk = db.pragma('foreign_keys', { simple: true });
  console.log('\n=== Pragma ===');
  console.log('  journal_mode:', wal, wal === 'wal' ? 'OK' : 'FAIL');
  console.log('  foreign_keys:', fk, fk === 1 ? 'OK' : 'FAIL');

  console.log('\n=== 行数 ===');
  ['dev_events', 'dev_experience', 'dev_patterns'].forEach(t => {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`  ${t}: ${c}`);
  });

  db.close();
  console.log('\n初始化完成');
}

main();
