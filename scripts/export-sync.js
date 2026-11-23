// scripts/export-sync.js —— 导出全量 L1 经验为 JSON，供本地拉取
const fs = require('fs');
const path = require('path');
const db = require('better-sqlite3')(path.join(__dirname, '../dev_knowledge.db'));

const outFile = path.join(__dirname, '../dev_knowledge_export.json');

// 导出所有未被淘汰（reusable=1）的经验，包含最新加的元数据字段
const rows = db.prepare(`
  SELECT id, ts, task_type, problem, solution, files_touched, outcome, adopted, used_count, reusable, is_permanent 
  FROM dev_experience 
  WHERE reusable = 1
`).all();

db.close();

const exportData = {
  export_time: new Date().toISOString(),
  version: '1.1',
  total: rows.length,
  data: rows,
};

fs.writeFileSync(outFile, JSON.stringify(exportData, null, 2), 'utf-8');
console.log(`✅ 导出成功！共 ${rows.length} 条经验，保存至 ${outFile}`);
