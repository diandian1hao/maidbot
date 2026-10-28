// scripts/bootstrap-dev-knowledge.js —— 冷启动灌入历史文件为 L0 事件
const path = require('path');
const fs = require('fs');
const dm = require('../core/devMemory');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SEGMENTS = 20;
const MIN_SEGMENT_LEN = 80;
const MAX_SEGMENT_LEN = 2000;

const FILES = [
  { path: 'README.md', taskType: 'note', label: '项目说明' },
  { path: 'CHANGELOG.md', taskType: 'note', label: '变更日志' },
  { path: 'ops-log.md', taskType: 'note', label: '运维日志' },
];

function splitByHeading(content) {
  const lines = content.split('\n');
  const segments = [];
  let current = { heading: '', lines: [] };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.lines.length > 0 && current.heading) {
        segments.push(current);
      }
      current = { heading: line.replace(/^##\s+/, '').trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 && current.heading) {
    segments.push(current);
  }

  return segments
    .map(s => ({ heading: s.heading, body: s.lines.join('\n').trim() }))
    .filter(s => s.body.length >= MIN_SEGMENT_LEN && s.body.length <= MAX_SEGMENT_LEN);
}

(async () => {
  console.log('=== Bootstrap 冷启动灌入 ===');
  console.log('模式:', DRY_RUN ? 'DRY-RUN（不写入）' : '实际写入');
  console.log('');

  const before = dm.stats();
  console.log('起始 stats:', before);
  console.log('');

  let totalSegments = 0;
  const pending = [];

  for (const f of FILES) {
    const fullPath = path.join(__dirname, '..', f.path);
    if (!fs.existsSync(fullPath)) {
      console.log(`SKIP ${f.path}（文件不存在）`);
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    const segments = splitByHeading(content);
    console.log(`[${f.label}] ${f.path}: ${segments.length} 段有效`);

    for (const seg of segments) {
      if (pending.length >= MAX_SEGMENTS) break;
      pending.push({
        source: 'file',
        taskType: f.taskType,
        rawInput: `# ${seg.heading}\n\n${seg.body}`,
        filesTouched: [f.path],
        outcome: 'success',
      });
    }
    totalSegments += segments.length;
  }

  console.log('');
  console.log(`总有效段: ${totalSegments}，准备写入: ${pending.length}（上限 ${MAX_SEGMENTS}）`);

  if (DRY_RUN) {
    console.log('\n=== 预览前 3 条 ===');
    pending.slice(0, 3).forEach((p, i) => {
      console.log(`\n--- 条目 ${i + 1} ---`);
      console.log('files:', p.filesTouched.join(','));
      console.log('rawInput 前 200 字:');
      console.log(p.rawInput.slice(0, 200) + (p.rawInput.length > 200 ? '...' : ''));
    });
    console.log('\n=== DRY-RUN 结束，未写入 ===');
    return;
  }

  console.log('\n=== 写入 L0 ===');
  const ids = [];
  for (const p of pending) {
    try {
      const r = dm.writeEvent(p);
      ids.push(r.id);
    } catch (e) {
      console.error('写入失败:', e.message);
    }
  }
  console.log(`写入完成: ${ids.length} 条`);

  const after = dm.stats();
  console.log('\n=== 结束 stats ===');
  console.log(after);
  console.log(`\nL0 events 增加: ${after.events - before.events}`);
})();
