/**
 * 固定窗口双层限流器（与 web-server.plugin.js 同构，抽出便于单测）
 * 维度1：perUser 每人每天 N 次；维度2：global 全站每天 M 次
 * 按自然日（UTC 日期串）自动重置
 */
class FixedWindowLimiter {
  constructor({ perUser = 10, global = 100 } = {}) {
    this.perUser = perUser;
    this.global = global;
    this.day = null;
    this.userCount = new Map();
    this.totalCount = 0;
  }
  _rollDay(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      this.userCount = new Map();
      this.totalCount = 0;
    }
  }
  check(userId, now = Date.now()) {
    this._rollDay(now);
    const used = this.userCount.get(userId) || 0;
    if (used >= this.perUser) {
      return { allowed: false, reason: 'user', remaining: 0, globalRemaining: this.global - this.totalCount };
    }
    if (this.totalCount >= this.global) {
      return { allowed: false, reason: 'global', remaining: this.perUser - used, globalRemaining: 0 };
    }
    this.userCount.set(userId, used + 1);
    this.totalCount += 1;
    return { allowed: true, remaining: this.perUser - used - 1, globalRemaining: this.global - this.totalCount };
  }
}
module.exports = { FixedWindowLimiter };
