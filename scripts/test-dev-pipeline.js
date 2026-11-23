const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { devChat } = require('../core/devPipeline');

(async () => {
  console.log('=== 测试：生成 + 异模型审查 ===');
  // 问一个容易写出 bug 的并发问题
  const r = await devChat('帮我写一个 PM2 的日志轮转脚本，要求清理超过7天的文件。');
  
  console.log(`\n【生成模型】: ${r.provider} | 【审查模型】: ${r.reviewer} | 总耗时: ${r.latency}ms\n`);
  
  console.log('--- 生成结果 ---');
  console.log(r.reply.slice(0, 400) + '...\n');
  
  console.log('--- 审查意见 ---');
  console.log(r.review);
})();
