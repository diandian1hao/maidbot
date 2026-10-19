require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mp = require('../core/modelProvider');

async function main() {
  console.log('=== Provider 状态 ===');
  console.table(mp.status());

  console.log('\n=== 测试 1：chat 路由（deepseek）===');
  const r1 = await mp.route('chat', '用一句话介绍你自己');
  console.log(`[${r1.provider}/${r1.model}] ${r1.content.slice(0, 80)}... (${r1.latency}ms)`);

  console.log('\n=== 测试 2：review_code 路由（glm）===');
  const r2 = await mp.route('review_code', '审查：const a = 1 + 1;');
  console.log(`[${r2.provider}/${r2.model}] ${r2.content.slice(0, 80)}... (${r2.latency}ms)`);

  console.log('\n=== 测试 3：强制 provider=glm ===');
  const r3 = await mp.route('chat', 'hi', { provider: 'glm' });
  console.log(`[${r3.provider}/${r3.model}] ${r3.content.slice(0, 80)}... (${r3.latency}ms)`);

  console.log('\n=== 测试 4：降级链（传不存在的 provider，应降级到 glm）===');
  const r4 = await mp.route('chat', 'hi', { provider: 'nonexistent' });
  console.log(`降级成功 → [${r4.provider}/${r4.model}]`);

  console.log('\n✅ 全部通过');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
