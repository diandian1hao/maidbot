const Database = require('better-sqlite3');
const modelProvider = require('./core/modelProvider');
const db = new Database('dev_knowledge.db');
const LIMIT = Number(process.argv[2] || 10);
const APPLY = process.argv.indexOf('--apply') !== -1;
const RANDOM = process.argv.indexOf('--random') !== -1;

const CRITERIA = '你是代码经验库的质检员。默认立场是怀疑，只有同时满足三条才允许通过：' +
  '\n1) 提到了具体技术实体（文件路径、函数名、库名、报错原文、版本号，至少一项）' +
  '\n2) 描述了可复现的触发条件（什么情况下会踩到）' +
  '\n3) 给出了明确可执行的处置动作（改哪个文件、改成什么）' +
  '\n任一条不满足就 rejected，并用一句话说清缺什么。' +
  '\n若只是「应该注意 X」「要保证 Y」这类没有实体的原则性表述，一律 rejected。' +
  '\n只输出 JSON：{"status":"passed" 或 "rejected","reason":"不超过60字"}';

function extractJSON(t) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < 0) return null; try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; } }
function judge(t) {
  const j = extractJSON(t);
  if (j) return { s: j.status === 'passed' ? 'passed' : 'rejected', r: j.reason || '' };
  const short = t.length < 200 && t.indexOf('function') === -1 && t.indexOf('const ') === -1;
  if (short && /passed/i.test(t) && !/rejected/i.test(t)) return { s: 'passed', r: '[兜底] ' + t.slice(0, 50) };
  if (short && /rejected/i.test(t)) return { s: 'rejected', r: '[兜底] ' + t.slice(0, 50) };
  return { s: 'unverified', r: '输出非 JSON 或疑似代码: ' + t.slice(0, 50) };
}

(async () => {
  const order = RANDOM ? " ORDER BY RANDOM()" : " ORDER BY id DESC";
  const rows = db.prepare("SELECT id, problem, solution FROM dev_experience WHERE audit_status = 'unverified'" + order + " LIMIT ?").all(LIMIT);
  console.log('样本', rows.length, '条', APPLY ? '(写库)' : '(dry-run)');
  let ok = 0, bad = 0, un = 0;
  for (const r of rows) {
    const prompt = CRITERIA + '\n\n【问题】' + (r.problem || '') + '\n【方案】' + String(r.solution || '').slice(0, 800);
    try {
      const res = await modelProvider.route('review_code', prompt, { temperature: 0 });
      const v = judge(res.content || '');
      console.log('#' + r.id, v.s, '|', v.r.slice(0, 60));
      if (v.s === 'passed') ok++; else if (v.s === 'rejected') bad++; else un++;
      if (APPLY) db.prepare('UPDATE dev_experience SET audit_status = ?, review_comments = ? WHERE id = ?').run(v.s, v.r, r.id);
    } catch (e) { console.log('#' + r.id, 'ERR', e.message); }
    await new Promise(z => setTimeout(z, 400));
  }
  console.log('结果: passed=' + ok + ' rejected=' + bad + ' unverified=' + un);
})();
