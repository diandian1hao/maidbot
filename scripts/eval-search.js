// scripts/eval-search.js —— 检索召回率人工评测
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const dm = require('../core/devMemory');

// 预设的真实开发问题（测试集）
const testCases = [
  'PM2 的日志太大了怎么清理？',
  '如何实现异模型审查？',
  'SSE 流式输出断流了怎么办？',
  '数据库双写不一致（孤儿点）怎么处理？',
  '如何将我的代码提交历史转化为经验？'
];

(async () => {
  console.log('=== 检索召回率评测 (Top-3) ===\n');
  let hitCount = 0;

  for (const query of testCases) {
    console.log(`❓ 用户提问: "${query}"`);
    
    // 走你写好的向量检索 + 精排
    const hits = await dm.searchExperience(query, { topK: 3 });
    
    if (hits.length === 0) {
      console.log('  ❌ 未命中任何经验');
    } else {
      hits.forEach((h, i) => {
        console.log(`  [${i+1}] (Score: ${h.score ? h.score.toFixed(3) : 'N/A'}) ${h.problem}`);
        console.log(`      方案: ${h.solution.substring(0, 50)}...`);
      });
      hitCount++;
    }
    console.log('-----------------------------------');
  }

  console.log(`\n📊 统计: ${hitCount}/${testCases.length} 的问题至少命中 1 条经验。`);
  console.log('提示: 请人工查看上面的输出，判断命中的经验是否合理。');
})();
