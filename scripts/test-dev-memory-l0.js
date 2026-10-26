// scripts/test-dev-memory-l0.js —— L0 层自测
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const dm = require('../core/devMemory');

function assert(cond, msg) {
  if (cond === false) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('OK:', msg);
}

console.log('=== 自检 ===');
console.log(JSON.stringify(dm.selfCheck(), null, 2));

console.log('\n=== 测试 1: writeEvent ===');
const e1 = dm.writeEvent({
  source: 'manual',
  taskType: 'note',
  rawInput: '测试 L0 写入',
  filesTouched: ['core/devMemory.js'],
});
assert(typeof e1.id === 'number' && e1.id > 0, 'writeEvent 返回有效 id');

console.log('\n=== 测试 2: getUndistilled ===');
const pending = dm.getUndistilled(10);
assert(pending.length >= 1, 'getUndistilled 能读到刚写的事件');
const hit = pending.find(p => p.id === e1.id);
assert(hit !== undefined, '刚写的事件在待蒸馏列表里');
assert(Array.isArray(hit.files_touched), 'files_touched 已反序列化为数组');
assert(hit.files_touched[0] === 'core/devMemory.js', 'files_touched 内容正确');

console.log('\n=== 测试 3: markDistilled ===');
dm.markDistilled([e1.id]);
const after = dm.getUndistilled(10);
const stillPending = after.find(p => p.id === e1.id);
assert(stillPending === undefined, 'markDistilled 后不再出现在待蒸馏列表');
assert(dm.stats().distilled >= 1, 'stats.distilled 已增加');

console.log('\n=== 测试 4: markUnstructured ===');
const e2 = dm.writeEvent({ source: 'manual', taskType: 'note', rawInput: '测试降级' });
dm.markUnstructured([e2.id]);
assert(dm.stats().unstructured >= 1, 'stats.unstructured 已增加');
const e2row = dm.getEventById(e2.id);
assert(e2row.distilled === -1, '降级事件 distilled = -1');
assert(e2row.unstructured === 1, '降级事件 unstructured = 1');

console.log('\n=== 测试 5: updateEventOutcome / adoptEvent ===');
dm.updateEventOutcome(e2.id, 'success');
dm.adoptEvent(e2.id);
const e2after = dm.getEventById(e2.id);
assert(e2after.outcome === 'success', 'outcome 更新为 success');
assert(e2after.adopted === 1, 'adopted = 1');

console.log('\n=== 清理测试数据 ===');
const db = dm._raw;
db.prepare('DELETE FROM dev_events WHERE id IN (?, ?)').run(e1.id, e2.id);
console.log('已清理 id=' + e1.id + ',' + e2.id);

console.log('\n=== 最终 stats ===');
console.log(dm.stats());

console.log('\n✅ L0 全部测试通过');
