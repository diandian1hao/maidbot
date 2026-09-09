/**
 * 线上冒烟测试：仅在本机手动 RUN_SMOKE=1 npm test 时执行，
 * CI 上自动跳过（CI 无法访问生产服务器）
 */
const RUN = process.env.RUN_SMOKE === '1';
const t = RUN ? test : test.skip;

t('线上实例 :3001 /api/status 返回 200 且含余量字段', async () => {
  const res = await fetch('http://127.0.0.1:3001/api/status');
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j).toHaveProperty('remaining');
  expect(j).toHaveProperty('globalRemaining');
}, 10000);
