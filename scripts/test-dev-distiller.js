const path = require('path');
process.chdir(path.join(__dirname, '..'));
const dd = require('../core/devDistiller');
const dm = require('../core/devMemory');

(async () => {
  console.log('=== 起始状态 ===');
  console.log(dm.stats());
  
  console.log('\n=== 开始蒸馏 3 条 ===');
  const stats = await dd.distillPending(3);
  
  console.log('\n=== 本轮结果 ===');
  console.log(stats);
  
  console.log('\n=== 结束状态 ===');
  console.log(dm.stats());
  
  const l1 = dm._raw.prepare('SELECT id, task_type, substr(problem, 1, 30) AS p FROM dev_experience ORDER BY id DESC LIMIT 3').all();
  console.log('\n=== 最新生成的 L1 ===');
  console.table(l1);
})();
