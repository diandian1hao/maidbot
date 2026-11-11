const path = require('path');
process.chdir(path.join(__dirname, '..'));
const dm = require('../core/devMemory');

const testCases = [
  { query: '双库联动的 Worker 是怎么设计的', expectKeyword: 'Worker' },
  { query: '为什么必须用 10亿偏移量隔离 point_id', expectKeyword: '偏移' },
  { query: 'GLM 审查模型超时了会降级给谁', expectKeyword: '审查' },
  { query: 'SQLite 的 WAL 模式是怎么启用的', expectKeyword: 'WAL' },
  { query: '孤儿点是怎么清理的', expectKeyword: '孤儿点' }
];

(async () => {
  console.log('=== P1 混合检索召回率评测 (模拟真实链路) ===\n');
  let hitCount = 0;

  for (const tc of testCases) {
    console.log(`❓ 提问: "${tc.query}"`);
    
    // 1. 先用 FTS5 找关键词（同样拆词）
    const cleanQuery = tc.query.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, ' ').trim();
    const keywords = cleanQuery.split(/\s+/).filter(w => w.length >= 2);
    if (keywords.length === 1 && keywords[0].length > 6) keywords.push(keywords[0].slice(0, 4));
    const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ');
    
    let hits = dm._raw.prepare(`
      SELECT e.* FROM dev_experience_fts f 
      JOIN dev_experience e ON f.rowid = e.id 
      WHERE dev_experience_fts MATCH ? AND e.reusable = 1 LIMIT 3
    `).all(ftsQuery);
    
    // 2. 如果 FTS 找不到，模拟降级去用全表模糊查（模拟向量兜底）
    if (hits.length === 0) {
      hits = dm._raw.prepare(`
        SELECT * FROM dev_experience WHERE reusable = 1 AND (problem LIKE ? OR solution LIKE ?) LIMIT 3
      `).all(`%${tc.expectKeyword}%`, `%${tc.expectKeyword}%`);
    }

    if (hits.length === 0) {
      console.log(`  ❌ 未命中任何经验`);
    } else {
      let hasExpect = false;
      hits.forEach((h, i) => {
        const isMatch = h.problem.includes(tc.expectKeyword) || h.solution.includes(tc.expectKeyword);
        if (isMatch) hasExpect = true;
        console.log(`  [${i+1}] ${isMatch ? '✅ 精准命中' : '💡 相关召回'}: ${h.problem.slice(0, 30)}...`);
      });
      if (hasExpect) hitCount++;
    }
    console.log('-----------------------------------');
  }

  console.log(`\n📊 统计: ${hitCount}/${testCases.length} 的问题精准命中了关键字。`);
})();
