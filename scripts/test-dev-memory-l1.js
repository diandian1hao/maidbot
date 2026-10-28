const path = require('path');
process.chdir(path.join(__dirname, '..'));
const dm = require('../core/devMemory');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('OK:', msg);
}

const cleanup = [];

(async () => {
  try {
    console.log('=== 测试 1: writeExperience ===');
    const e1 = dm.writeEvent({ source: 'manual', taskType: 'note', rawInput: 'L1 测试源' });
    cleanup.push(['dev_events', e1.id]);
    const x1 = dm.writeExperience({
      sourceEventId: e1.id, taskType: 'bugfix',
      problem: 'SSE 输出被 Nginx 缓冲', solution: 'proxy_buffering off',
      filesTouched: ['plugins/web-server.plugin.js'],
    });
    cleanup.push(['dev_experience', x1.id]);
    assert(typeof x1.id === 'number' && x1.id > 0, 'writeExperience 返回有效 id');

    console.log('\n=== 测试 2: getExperienceById ===');
    const row = dm.getExperienceById(x1.id);
    assert(row !== null, '能读到');
    assert(row.task_type === 'bugfix', 'task_type 正确');
    assert(row.embedding_status === 'pending', '默认 pending');

    console.log('\n=== 测试 3: updateEmbeddingStatus ===');
    dm.updateEmbeddingStatus(x1.id, 'done', 'dev_exp_' + x1.id);
    const row2 = dm.getExperienceById(x1.id);
    assert(row2.embedding_status === 'done', '状态更新');

    console.log('\n=== 测试 4: adoptExperience ===');
    dm.adoptExperience(x1.id);
    assert(dm.getExperienceById(x1.id).adopted === 1, 'adopted=1');

    console.log('\n=== 测试 5: searchExperience（async）===');
    const hits = await dm.searchExperience('SSE 被缓冲', { topK: 3, taskType: 'bugfix' });
    assert(Array.isArray(hits), '返回数组');

    console.log('\n=== 测试 6: 外键 ON DELETE SET NULL ===');
    dm._raw.prepare('DELETE FROM dev_events WHERE id = ?').run(e1.id);
    const rowAfter = dm.getExperienceById(x1.id);
    assert(rowAfter !== null, 'L1 行还在');
    assert(rowAfter.source_event_id === null, 'source_event_id 置 NULL');

    console.log('\n=== 测试 7: 必填校验 ===');
    let threw = false;
    try { dm.writeExperience({ taskType: 'note' }); } catch (e) { threw = true; }
    assert(threw, '缺必填字段抛异常');

    console.log('\n=== 清理 ===');
    for (const [t, id] of cleanup) {
      try { dm._raw.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id); } catch (_) {}
    }
    console.log('已清理');
    console.log('\n✅ L1 全部测试通过（async 版）');
  } catch (e) {
    console.error('\n❌', e.message);
    console.error(e.stack);
    for (const [t, id] of cleanup) {
      try { dm._raw.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id); } catch (_) {}
    }
    process.exit(1);
  }
})();
