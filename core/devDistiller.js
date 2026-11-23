const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const modelProvider = require('./modelProvider');
const dm = require('./devMemory');
const crypto = require('crypto');

const PROMPT_FILE = path.join(__dirname, '../prompts/dev-distill.md');

function buildPrompt(l0Event) {
  let template = '';
  try {
    template = fs.readFileSync(PROMPT_FILE, 'utf-8');
  } catch (e) {
    throw new Error('无法读取蒸馏提示词文件: ' + e.message);
  }
  const base = template
    .replace('{{taskType}}', l0Event.task_type || 'unknown')
    .replace('{{files}}', (l0Event.files_touched || []).join(', '))
    .replace('{{rawInput}}', l0Event.raw_input || '');
  const output = String(l0Event.raw_output || '').slice(0, 3000);
  return base + (output ? '\n\n【本轮实际产出（代码/回复节选）】\n' + output : '');
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || start > end) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

async function _distillPending(limit = 10) {
  logger.info(`[DevDistiller] 开始蒸馏，上限 ${limit} 条`);
  const events = dm.getUndistilled(limit);
  if (events.length === 0) return { success: 0, fail: 0, unstructured: 0 };

  let stats = { success: 0, fail: 0, unstructured: 0 };

  for (const ev of events) {
    try {
      var _BT = String.fromCharCode(96);
      if (String(ev.raw_output || '').indexOf(_BT + _BT + _BT) === -1) {
        logger.info('[DevDistiller] 跳过无代码产出的 L0: id=' + ev.id);
        dm.markUnstructured([ev.id]);
        stats.unstructured++;
        continue;
      }
      const prompt = buildPrompt(ev);
      const res = await modelProvider.route('review_code', prompt, { temperature: 0.1 });
      const parsed = extractJSON(res.content);

      if (!parsed || parsed.reusable === false || !parsed.problem || !parsed.solution) {
        dm.markUnstructured([ev.id]);
        stats.unstructured++;
        continue;
      }

      let finalSolution = parsed.solution;
      if (ev.outcome === 'failed') finalSolution = `【避坑指南】${finalSolution}`;

      // 🆕 完美的继承机制：从 L0 继承归属
      
      let auditStatus = 'pending';
      let reviewComments = null;
      
      // 🆕 核心升级：引入异构审核（质检员）
      try {
        const auditPrompt = `你是一个严格的代码架构审查专家。请审查以下提炼出的开发经验是否具有可复用性、正确性和通用性。
【问题】${parsed.problem}
【方案】${finalSolution}

【输出要求】
输出纯 JSON 格式：
{"status": "passed" 或 "rejected", "reason": "审查意见(不超过50字)"}`;
        
        const auditRes = await modelProvider.route('review_code', auditPrompt, { temperature: 0 }).catch(() => modelProvider.route('review_code', auditPrompt, { temperature: 0 }));
        const auditParsed = extractJSON(auditRes.content);
        
        if (auditParsed && auditParsed.reason) {
          auditStatus = auditParsed.status === 'passed' ? 'passed' : 'rejected';
          reviewComments = auditParsed.reason || '';
        } else {
          const _t = String(auditRes.content || '');
          const _pass = /passed|通过/i.test(_t) && !/rejected|不通过|驳回|不可复用/i.test(_t);
          const _fail = /rejected|不通过|驳回|不可复用/i.test(_t);
          if (_pass) { auditStatus = 'passed'; }
          else if (_fail) { auditStatus = 'rejected'; }
          else { auditStatus = 'unverified'; }
          reviewComments = _t.slice(0, 80);
          logger.warn('[DevDistiller] 审核输出非 JSON，走关键词兜底 -> ' + auditStatus + ': ' + _t.slice(0, 120));
        }
      } catch (auditErr) {
        logger.warn(`[DevDistiller] 经验质检失败，跳过质检直接入库: ${auditErr.message}`);
        auditStatus = 'unverified';
      }

      const exp = dm.writeExperience({
        sourceEventId: ev.id,
        groupName: ev.group_name || 'common',
        projectName: ev.project_name || 'global',
        taskType: parsed.task_type || ev.task_type || 'note',
        problem: parsed.problem,
        solution: finalSolution,
        filesTouched: parsed.files_touched || ev.files_touched || [],
        outcome: ev.outcome || 'success',
        auditStatus: auditStatus,
        reviewComments: reviewComments
      });

      try {
        const ch = _codeHash(ev.raw_output);
        if (ch) dm._raw.prepare('UPDATE dev_experience SET code_hash = ? WHERE id = ?').run(ch, exp.id);
      } catch (e2) {}

      // 同步向量（假设有 syncExperienceToVector 方法，如果没有请忽略或自行实现）
      if (typeof dm.syncExperienceToVector === 'function') {
        await dm.syncExperienceToVector(exp.id);
      }
      
      dm.markDistilled([ev.id]);
      stats.success++;
      
    } catch (e) {
      logger.error(`[DevDistiller] 异常: ${e.message}`);
      stats.fail++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  logger.info(`[DevDistiller] 蒸馏完成: ${JSON.stringify(stats)}`);
  return stats;
}


// 🆕 代码指纹
function _codeHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}

// 🆕 互斥锁：定时任务与事件触发不并发
const _running = { busy: false };
async function distillPending(limit = 10) {
  if (_running.busy) { logger.info('[DevDistiller] 已有蒸馏在跑，跳过本次'); return { skipped: true }; }
  _running.busy = true;
  try { return await _distillPending(limit); } finally { _running.busy = false; }
}

// 🆕 事件触发：同一项目每小时最多 3 次
const _recent = new Map();
async function triggerAfterRound(opts) {
  const key = String((opts && opts.groupName) || 'common') + '/' + String((opts && opts.projectName) || 'global');
  const now = Date.now();
  const arr = (_recent.get(key) || []).filter(function (t) { return now - t < 3600000; });
  if (arr.length >= 3) { logger.info('[DevDistiller] 触发限流跳过: ' + key); return { skipped: true }; }
  arr.push(now); _recent.set(key, arr);
  logger.info('[DevDistiller] 事件触发: ' + key);
  return distillPending(2);
}

module.exports = { distillPending, triggerAfterRound };
