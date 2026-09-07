// verify_p1.js - P1 自测：去重 / TTL / 清理
const memory = require('./core/memory');

const UID = '__verify_p1__';
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else      { fail++; console.log('  ❌ ' + name); }
};

memory.clear(UID); // 开始前清场

console.log('--- [1] 基本写入/读取 ---');
memory.append(UID, 'user', '你好');
memory.append(UID, 'assistant', '你好，主人');
ok(memory.getHistory(UID).length === 2, 'getHistory 取回 2 条');

console.log('--- [2] 写入去重 ---');
memory.append(UID, 'user', '你好');
ok(memory.getHistory(UID).length === 2, '同角色+同内容 被跳过');
memory.append(UID, 'assistant', '你好');
ok(memory.getHistory(UID).length === 3, '同内容但不同角色 不算重复');

console.log('--- [3] TTL 过期过滤 ---');
memory._raw.prepare("UPDATE messages SET expires_at = datetime('now','-1 hour') WHERE user_id = ?").run(UID);
ok(memory.getHistory(UID).length === 0, 'getHistory 不返回过期消息');

console.log('--- [4] purgeExpired 清理 ---');
const n = memory.purgeExpired();
ok(n >= 3, 'purgeExpired 删了 ' + n + ' 条过期');
ok(memory._raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?').get(UID).n === 0, '测试账号无残留');

memory.clear(UID);
console.log(fail === 0 ? '\n🎉 P1 验证全部通过' : '\n💥 ' + fail + ' 项失败，检查上面 ❌');
process.exit(fail === 0 ? 0 : 1);
