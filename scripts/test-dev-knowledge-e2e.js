// scripts/test-dev-knowledge-e2e.js —— W2 数据层端到端测试
// 覆盖：L0 写入 → 模拟蒸馏 → L1 写入 → 向量同步 → 检索命中 → 埋点
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

    const statsBefore = dm.stats();
    console.log('\n=== 起始 stats ===');
    console.log(statsBefore);

    // ========== 步骤 1：写 L0 ==========
    console.log('\n=== 步骤 1: 写 L0 原始事件 ===');
    const e1 = dm.writeEvent({
      source: 'manual',
      taskType: 'bugfix',
      rawInput: 'E2E: SSE 输出断流，前端一直转圈',
      rawOutput: '在 Nginx 加了 proxy_buffering off 和 X-Accel-Buffering no',
      filesTouched: ['plugins/web-server.plugin.js', 'nginx.conf'],
      outcome: 'success',
    });
    cleanup.push(['dev_events', e1.id]);
    assert(typeof e1.id === 'number' && e1.id > 0, 'L0 写入成功 id=' + e1.id);

    // ========== 步骤 2：读待蒸馏 ==========
    console.log('\n=== 步骤 2: getUndistilled ===');
    const pending = dm.getUndistilled(100);
    assert(pending.length >= 1, '待蒸馏列表非空');
    const found = pending.find(p => p.id === e1.id);
    assert(found !== undefined, '刚写的 L0 在待蒸馏列表里');
    assert(Array.isArray(found.files_touched) && found.files_touched.length === 2, 'files_touched 反序列化正确');

    // ========== 步骤 3：模拟蒸馏（W3 之前直接写 L1）==========
    console.log('\n=== 步骤 3: 模拟蒸馏 → 写 L1 ===');
    const x1 = dm.writeExperience({
      sourceEventId: e1.id,
      taskType: 'bugfix',
      problem: 'SSE 输出断流，前端一直转圈',
      solution: 'Nginx 关闭 proxy_buffering，设置 X-Accel-Buffering no',
      filesTouched: ['plugins/web-server.plugin.js', 'nginx.conf'],
      outcome: 'success',
    });
    cleanup.push(['dev_experience', x1.id]);
    assert(typeof x1.id === 'number' && x1.id > 0, 'L1 写入成功 id=' + x1.id);

    // ========== 步骤 4：标记 L0 已蒸馏 ==========
    console.log('\n=== 步骤 4: markDistilled ===');
    dm.markDistilled([e1.id]);
    const eAfter = dm.getEventById(e1.id);
    assert(eAfter.distilled === 1, 'L0 distilled=1');
    const pendingAfter = dm.getUndistilled(100);
    assert(!pendingAfter.find(p => p.id === e1.id), '已蒸馏的 L0 不再出现在待蒸馏列表');

    // ========== 步骤 5：向量同步 ==========
    console.log('\n=== 步骤 5: syncExperienceToVector ===');
    const sync = await dm.syncExperienceToVector(x1.id);
    assert(sync.ok === true, '向量同步成功');
    assert(sync.pointId === 1_000_000_000 + x1.id, 'point_id = 1e9 + L1.id');

    const xAfter = dm.getExperienceById(x1.id);
    assert(xAfter.embedding_status === 'done', 'embedding_status = done');
    assert(xAfter.vector_id === String(sync.pointId), 'vector_id 已写入');

    // ========== 步骤 6：向量检索 ==========
    console.log('\n=== 步骤 6: searchExperience 向量检索 ===');
    await new Promise(r => setTimeout(r, 500));
    const hits = await dm.searchExperience('SSE 断流 缓冲', { topK: 3 });
    assert(Array.isArray(hits), '返回数组');
    assert(hits.length >= 1, '至少命中 1 条');
    assert(hits[0].id === x1.id, '命中的是刚灌的那条');
    assert(typeof hits[0].score === 'number', 'score 是数字');
    console.log('  top hit score:', hits[0].score.toFixed(4));

    // ========== 步骤 7：埋点验证 ==========
    console.log('\n=== 步骤 7: 埋点记录 ===');
    const log = dm._raw.prepare('SELECT * FROM dev_search_log ORDER BY id DESC LIMIT 1').get();
    assert(log.hit_count >= 1, '埋点 hit_count >= 1');
    assert(typeof log.top_score === 'number', '埋点 top_score 是数字');
    assert(log.query.includes('SSE'), '埋点 query 正确');
    console.log('  最近一条埋点:', JSON.stringify({
      query: log.query,
      hit_count: log.hit_count,
      top_score: log.top_score,
      source: log.source,
      latency_ms: log.latency_ms,
    }));

    // ========== 步骤 8：stats 对比 ==========
    console.log('\n=== 步骤 8: stats 对比 ===');
    const statsAfter = dm.stats();
    console.log('起始:', statsBefore);
    console.log('结束:', statsAfter);
    assert(statsAfter.events === statsBefore.events + 1, 'events +1');
    assert(statsAfter.experience === statsBefore.experience + 1, 'experience +1');
    assert(statsAfter.distilled === statsBefore.distilled + 1, 'distilled +1');
    assert(statsAfter.search_log > statsBefore.search_log, 'search_log 增加');

    // ========== 步骤 9：清理 ==========
    console.log('\n=== 步骤 9: 清理测试数据 ===');
    for (const [t, id] of cleanup) {
      try { dm._raw.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id); } catch (_) {}
    }
    // 尝试清理向量库
    try {
      await fetch('http://127.0.0.1:8000/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point_id: sync.pointId }),
      });
    } catch (_) {}
    console.log('已清理 SQLite + 尝试清理向量');

    console.log('\n=== 最终 stats ===');
    console.log(dm.stats());

    console.log('\n✅ E2E 全部通过（数据层闭环验证完成）');
  } catch (e) {
    console.error('\n❌ E2E 异常:', e.message);
    console.error(e.stack);
    for (const [t, id] of cleanup) {
      try { dm._raw.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id); } catch (_) {}
    }
    process.exit(1);
  }
})();
