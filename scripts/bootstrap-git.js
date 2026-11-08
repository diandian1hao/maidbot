// scripts/bootstrap-git.js —— 从 Git 提交历史中提取开发经验
const { execSync } = require('child_process');
const path = require('path');
const dm = require('../core/devMemory');

// 获取 git log，格式：hash|作者|日期|标题
const cmd = `git log -n 100 --pretty=format:"%h|%an|%ad|%s" --date=short`;
let logOutput = '';

try {
  logOutput = execSync(cmd, { cwd: path.join(__dirname, '..'), encoding: 'utf-8' });
} catch (e) {
  console.error('❌ 获取 git log 失败:', e.message);
  process.exit(1);
}

const lines = logOutput.split('\n').filter(Boolean);
console.log(`📥 获取到 ${lines.length} 条 Git 记录，开始清洗...`);

// 🆕 精细化清洗策略：只提取 feat 和 fix 类型，排除 docs 和 chore 等纯记录
const validCommits = [];

for (const line of lines) {
  const parts = line.split('|');
  if (parts.length < 4) continue;
  
  const [hash, author, date, message] = parts;
  const lowerMsg = message.toLowerCase();
  
  // 必须是以 feat 或 fix 开头（包含带括号的，如 feat(W4):）
  const isCodeChange = lowerMsg.startsWith('feat') || lowerMsg.startsWith('fix');
  if (!isCodeChange) continue;

  // 排除太短的
  if (message.trim().length < 15) continue;

  validCommits.push({ hash, author, date, message });
}

console.log(`✅ 清洗后剩下 ${validCommits.length} 条高价值代码提交记录。`);

if (validCommits.length === 0) {
  console.log('没有可导入的记录，退出。');
  process.exit(0);
}

// 批量写入 L0
let count = 0;
for (const c of validCommits) {
  try {
    dm.writeEvent({
      source: 'git',
      taskType: 'commit',
      rawInput: `Git 提交记录 [${c.date}] ${c.hash}\n内容: ${c.message}`,
      rawOutput: '这是一次代码提交，请提取开发经验。',
      filesTouched: [],
      outcome: 'success'
    });
    count++;
  } catch (e) {
    console.error(`写入 ${c.hash} 失败:`, e.message);
  }
}

console.log(`🎉 成功将 ${count} 条 Git 提交写入 L0 经验库！`);
