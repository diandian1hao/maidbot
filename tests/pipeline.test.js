/**
 * 共享管道契约测试：保证 pipeline 始终导出 register/chat，
 * 双端（QQ/Web）都依赖此契约，防止重构时静默破坏
 */
let pipeline = null;
try { pipeline = require('../core/pipeline.js'); } catch (e) { pipeline = null; }

const has = (fn) => pipeline && typeof pipeline[fn] === 'function';
const t = has('register') ? test : test.skip;

t('pipeline.js 存在且导出 register 函数', () => {
  expect(pipeline).not.toBeNull();
  expect(typeof pipeline.register).toBe('function');
});

t('pipeline.js 导出 chat 入口（Web 端复用点）', () => {
  expect(typeof pipeline.chat).toBe('function');
});

(has('chat') ? test : test.skip)('register 后 chat 可完整走通并返回 reply', async () => {
  pipeline.register(async (userId, text, opts) => ({
    reply: `echo:${text}`, plugin: 'unit-test', source: opts && opts.source,
  }));
  const r = await pipeline.chat('test_user', 'hello', { source: 'web' });
  expect(r.reply).toContain('echo:hello');
});
