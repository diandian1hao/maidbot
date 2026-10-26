#!/usr/bin/env node
// 安全的 SQLite Online Backup（WAL 模式下不会损坏）
// 支持多库：chat_memory / maid_memory / dev_knowledge
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const BASE_DIR = path.join(__dirname, '..');
const BACKUP_DIR = path.join(BASE_DIR, 'backups/db');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const DATABASES = [
  { name: 'chat_memory',  path: path.join(BASE_DIR, 'chat_memory.db') },
  { name: 'maid_memory',  path: path.join(BASE_DIR, 'maid_memory.db') },
  { name: 'dev_knowledge', path: path.join(BASE_DIR, 'dev_knowledge.db') },
];

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let failed = 0;

(async () => {
  for (const db of DATABASES) {
    if (fs.existsSync(db.path) === false) {
      console.log(`[Backup] SKIP ${db.name}（文件不存在）`);
      continue;
    }
    const dest = path.join(BACKUP_DIR, `${db.name}_${ts}.db`);
    try {
      const src = new Database(db.path, { readonly: true });
      await src.backup(dest);
      src.close();
      const size = (fs.statSync(dest).size / 1024).toFixed(1);
      console.log(`[Backup] OK ${db.name} -> ${path.basename(dest)} (${size} KB)`);
    } catch (e) {
      failed++;
      console.error(`[Backup] FAIL ${db.name}: ${e.message}`);
    }
  }

  // 每个库保留最近 7 份
  const all = fs.readdirSync(BACKUP_DIR);
  for (const db of DATABASES) {
    const files = all
      .filter(f => f.startsWith(db.name + '_'))
      .sort()
      .reverse();
    files.slice(7).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    });
  }

  if (failed > 0) process.exit(1);
})();
