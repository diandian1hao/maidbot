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

const cleanup = [];

try {
  console.log('=== 自检 ===');
  console.log(JSON.stringify(dm.selfCheck(), null, 2));

  console.log('\n=== 测试 1: writeExperience（关联一条 L0）===');
  const e1 = dm.writeEvent({ source: 'manual', taskType: 'note', rawInput: 'L1 测试的源事件' });
  cleanup.push(['dev_events', e1.id]);

  const x1 = dm.writeExperience({
    sourceEventId: e1.id,
    taskType: 'bugfix',
    problem: 'SSE 输出被 Nginx 缓冲',
    solution: 'proxy_buffering off; X-Accel-Buffering no',
    filesTouched: ['plugins/web-server.plugin.js'],
    outcome: 'success',
  });
  cleanup.push(['dev_experience', x1.id]);
  assert(typeof x1.id === 'number' && x1.id > 0, 'writeExperience 返回有效 id');

  console.log('\n=== 测试 2: getExperienceById ===');
  const row = dm.getExperienceById(x1.id);
  assert(row !== null, 'getExperienceById 能读到');
  assert(row.task_type === 'bugfix', 'task_type 正确');
  assert(row.problem === 'SSE 输出被 Nginx 缓冲', 'problem 正确');
  assert(row.embedding_status === 'pending', '默认 embedding_status = pending');
  assert(Array.isArray(row.files_touched) && row.files_touched[0] === 'plugins/web-server.plugin.js', 'files_touched 反序列化正确');

  console.log('\n=== 测试 3: updateEmbeddingStatus ===');
  dm.updateEmbeddingStatus(x1.id, 'done', 'dev_exp_' + x1.id);
  const row2 = dm.getExperienceById(x1.id);
  assert(row2.embedding_status === 'done', 'embedding_status 更新为 done');
  assert(row2.vector_id === 'dev_exp_' + x1.id, 'vector_id 已写入');

  console.log('\n=== 测试 4: adoptExperience ===');
  dm.adoptExperience(x1.id);
  const row3 = dm.getExperienceById(x1.id);
  assert(row3.adopted === 1, 'adopted = 1');

  console.log('\n=== 测试 5: searchExperience（SQLite fallback）===');
  const hits = dm.searchExperience('SSE 被缓冲', { topK: 3, taskType: 'bugfix' });
  assert(Array.isArray(hits), '返回数组');
  assert(hits.length >= 1, '至少命中 1 条');
  assert(hits[0].id === x1.id, '命中的是我们写入的那条');
  assert(hits[0].adopted === 1, 'adopted=1 的条目优先返回');

  console.log('\n=== 测试 6: 外键 ON DELETE SET NULL ===');
  dm._raw.prepare('DELETE FROM dev_events WHERE id = ?').run(e1.id);
  const rowAfterDelete = dm.getExperienceById(x1.id);
  assert(rowAfterDelete !== null, 'L1 行还在');
  assert(rowAfterDelete.source_event_id === null, 'source_event_id 被置为 NULL');

  console.log('\n=== 测试 7: writeExperience 必填校验 ===');
  let threw = false;
  try {
    dm.writeExperience({ taskType: 'note' });
  } catch (e) {
    threw = true;
    console.log('  预期异常:', e.message);
  }
  assert(threw === true, '缺必填字段抛异常');

  console.log('\n=== 清理测试数据 ===');
  for (const item of cleanup) {
    try { dm._raw.prepare('DELETE FROM ' + item[0] + ' WHERE id = ?').run(item[1]); } catch (_) {}
  }
  console.log('已清理', cleanup.length, '条');

  console.log('\n=== 最终 stats ===');
  console.log(dm.stats());

  console.log('\n✅ L1 全部测试通过');
} catch (e) {
  console.error('\n❌ 测试异常:', e.message);
  console.error(e.stack);
  for (const item of cleanup) {
    try { dm._raw.prepare('DELETE FROM ' + item[0] + ' WHERE id = ?').run(item[1]); } catch (_) {}
  }
  process.exit(1);
}
