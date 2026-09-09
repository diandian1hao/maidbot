const { FixedWindowLimiter } = require('../lib/ratelimit');

describe('双层限流器（个人 10 次/天 + 全站 100 次/天）', () => {
  test('前 10 次请求全部放行，且余量递减', () => {
    const lim = new FixedWindowLimiter({ perUser: 10, global: 100 });
    for (let i = 0; i < 10; i++) {
      const r = lim.check('web_1.2.3.4');
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(9 - i);
    }
  });

  test('第 11 次触发个人限流，reason=user', () => {
    const lim = new FixedWindowLimiter({ perUser: 10, global: 100 });
    for (let i = 0; i < 10; i++) lim.check('u1');
    const r = lim.check('u1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('user');
  });

  test('不同用户额度互相隔离', () => {
    const lim = new FixedWindowLimiter({ perUser: 2, global: 100 });
    lim.check('u1'); lim.check('u1');
    expect(lim.check('u1').allowed).toBe(false);
    expect(lim.check('u2').allowed).toBe(true); // u2 不受 u1 影响
  });

  test('全站额度耗尽后，未超个人额度的用户也被拦截，reason=global', () => {
    const lim = new FixedWindowLimiter({ perUser: 10, global: 3 });
    lim.check('a'); lim.check('b'); lim.check('c');
    const r = lim.check('d');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('global');
    expect(r.globalRemaining).toBe(0);
  });

  test('跨自然日自动重置', () => {
    const lim = new FixedWindowLimiter({ perUser: 1, global: 100 });
    const day1 = new Date('2026-09-10T12:00:00Z').getTime();
    const day2 = new Date('2026-09-11T00:00:01Z').getTime();
    expect(lim.check('u1', day1).allowed).toBe(true);
    expect(lim.check('u1', day1).allowed).toBe(false);
    expect(lim.check('u1', day2).allowed).toBe(true); // 新的一天，额度恢复
  });

  test('globalRemaining 随消耗实时递减（供页脚公示）', () => {
    const lim = new FixedWindowLimiter({ perUser: 10, global: 100 });
    expect(lim.check('u1').globalRemaining).toBe(99);
    expect(lim.check('u1').globalRemaining).toBe(98);
  });
});
