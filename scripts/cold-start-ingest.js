const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dm = require('../core/devMemory');

const BASE_DIR = path.join(__dirname, '..');
const TARGET_FILES = ['README.md', 'CHANGELOG.md', 'ops-log.md'];
const MAX_SEG = 30;

function splitByHeading(content) {
  const lines = content.split('\n');
  const segments = [];
  let current = { heading: '', lines: [] };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.lines.length > 0 && current.heading) segments.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 && current.heading) segments.push(current);

  return segments
    .map(s => ({ heading: s.heading, body: s.lines.join('\n').trim() }))
    .filter(s => s.body.length >= 80 && s.body.length <= 2000);
}

(async () => {
  console.log('=== 开始 P1 冷启动灌入（目标：common 公共池）===');
  let count = 0;
  const before = dm.stats().events;

  // 1. 灌入文档
  for (const file of TARGET_FILES) {
    const fullPath = path.join(BASE_DIR, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const segs = splitByHeading(content);
    
    for (const seg of segs) {
      if (count >= MAX_SEG) break;
      dm.writeEvent({
        source: 'bootstrap',
        groupName: 'common',
        projectName: 'global-knowledge',
        taskType: 'note',
        rawInput: `# ${seg.heading}\n\n${seg.body}`,
        rawOutput: '文档切片冷启动',
        outcome: 'success'
      });
      count++;
    }
  }
  console.log(`✅ 文档灌入完成，共 ${count} 条`);

  // 2. 灌入 Git Log
  try {
    const gitLog = execSync('git log -n 30 --pretty=format:"%s"', { cwd: BASE_DIR, encoding: 'utf-8' });
    const lines = gitLog.split('\n').filter(l => l.trim().length > 10 && (l.startsWith('feat') || l.startsWith('fix')));
    for (const msg of lines) {
      if (count >= MAX_SEG + 10) break;
      dm.writeEvent({
        source: 'bootstrap',
        groupName: 'common',
        projectName: 'global-knowledge',
        taskType: 'note',
        rawInput: `Git 提交记录: ${msg}`,
        rawOutput: 'Git 历史冷启动',
        outcome: 'success'
      });
      count++;
    }
    console.log(`✅ Git Log 灌入完成，累计 ${count} 条`);
  } catch (e) {
    console.log('⚠️ Git Log 获取失败，跳过');
  }

  const after = dm.stats().events;
  console.log(`🎉 灌入结束！L0 原始事件从 ${before} 增至 ${after}。`);
  console.log(`💡 接下来请运行蒸馏脚本，将它们转化为 L1 经验。`);
})();
