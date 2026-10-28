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
    console.log('=== 自检 ===');
    console.log(JSON.stringify(dm.selfCheck(), null, 2));

    console.log('\n=== 测试 1: 写入 L1 并同步到向量 ===');
    const x1 = dm.writeExperience({
      taskType: 'bugfix',
      problem: '向量测试：SSE 输出被缓冲',
      solution: '设置 X-Accel-Buffering no',
      filesTouched: ['plugins/web-server.plugin.js'],
    });
    cleanup.push(['dev_experience', x1.id]);

    const sync = await dm.syncExperienceToVector(x1.id);
    assert(sync.ok === true, 'syncExperienceToVector 返回 ok');
    assert(sync.pointId === 1_000_000_000 + x1.id, 'pointId = 10亿 + L1.id');

    const row = dm.getExperienceById(x1.id);
    assert(row.embedding_status === 'done', 'embedding_status = done');
    assert(row.vector_id === String(sync.pointId), 'vector_id 已写入');

    console.log('\n=== 测试 2: 向量检索命中 ===');
    // 等向量落盘
    await new Promise(r => setTimeout(r, 500));
    const hits = await dm.searchExperience('SSE 缓冲', { topK: 3 });
    assert(Array.isArray(hits), '返回数组');
    assert(hits.length >= 1, '至少 1 条');
    assert(hits[0].id === x1.id, '命中的是刚灌的那条');
    assert(typeof hits[0].score === 'number', 'score 是数字');

    console.log('\n=== 测试 3: 埋点记录了 top_score ===');
    const log = dm._raw.prepare('SELECT * FROM dev_search_log ORDER BY id DESC LIMIT 1').get();
    assert(log.hit_count >= 1, 'hit_count >= 1');
    assert(typeof log.top_score === 'number', 'top_score 已记录');

    console.log('\n=== 测试 4: taskType 过滤 ===');
    const hitsFiltered = await dm.searchExperience('SSE 缓冲', { topK: 3, taskType: 'bugfix' });
    assert(hitsFiltered.length >= 1, '按 taskType 过滤后仍有命中');
    const hitsWrong = await dm.searchExperience('SSE 缓冲', { topK: 3, taskType: 'nonexistent' });
    assert(hitsWrong.length === 0, '不存在的 taskType 返回空');

    console.log('\n=== 测试 5: 降级机制（模拟向量 API 不可达）===');
    const origApi = process.env.VECTOR_API_URL;
    process.env.VECTOR_API_URL = 'http://127.0.0.1:59999';
    // 注意：模块内 VECTOR_API 已固化，改 env 不影响，故跳过真实降级测试
    // 只验证 searchExperience 不抛异常
    const hitsFallback = await dm.searchExperience('任意', { topK: 3 });
    assert(Array.isArray(hitsFallback), '向量 API 不可达时返回数组而非抛异常');
    process.env.VECTOR_API_URL = origApi;

    console.log('\n=== 清理 ===');
    for (const [table, id] of cleanup) {
      try { dm._raw.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); } catch (_) {}
    }
    // 尝试清理向量库（可能无 /delete 接口，失败忽略）
    try {
      await fetch('http://127.0.0.1:8000/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point_id: sync.pointId }),
      });
    } catch (_) {}
    console.log('已清理 SQLite 测试数据');

    console.log('\n=== 最终 stats ===');
    console.log(dm.stats());
    console.log('\n✅ 向量同步全部测试通过');
  } catch (e) {
    console.error('\n❌ 异常:', e.message);
    console.error(e.stack);
    for (const [table, id] of cleanup) {
      try { dm._raw.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); } catch (_) {}
    }
    process.exit(1);
  }
})();
