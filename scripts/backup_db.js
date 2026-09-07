#!/usr/bin/env node
// 安全的 SQLite Online Backup（WAL 模式下不会损坏）
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../chat_memory.db');
const BACKUP_DIR = path.join(__dirname, '../backups/db');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(BACKUP_DIR, `chat_memory_${ts}.db`);

// ✅ 正确用法：以 readonly 打开源库，.backup(目标路径字符串)
const src = new Database(DB_PATH, { readonly: true });
src.backup(dest).then(() => {
  console.log(`[Backup] ✅ ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
  src.close();
  // 保留最近 7 份
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('chat_memory_'))
    .sort().reverse();
  files.slice(7).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}).catch(e => { console.error('[Backup] ❌', e.message); process.exit(1); });
