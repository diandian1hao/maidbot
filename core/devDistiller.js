// core/devDistiller.js —— L0 -> L1 蒸馏胶水逻辑
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const modelProvider = require('./modelProvider');
const dm = require('./devMemory');

const PROMPT_FILE = path.join(__dirname, '../prompts/dev-distill.md');

function buildPrompt(l0Event) {
  let template = '';
  try {
    template = fs.readFileSync(PROMPT_FILE, 'utf-8');
  } catch (e) {
    throw new Error('无法读取蒸馏提示词文件: ' + e.message);
  }
  return template
    .replace('{{taskType}}', l0Event.task_type || 'unknown')
    .replace('{{files}}', (l0Event.files_touched || []).join(', '))
    .replace('{{rawInput}}', l0Event.raw_input || '');
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

async function distillPending(limit = 10) {
  logger.info(`[DevDistiller] 开始蒸馏，上限 ${limit} 条`);
  const events = dm.getUndistilled(limit);
  if (events.length === 0) {
    logger.info('[DevDistiller] 没有待蒸馏的 L0 事件');
    return { success: 0, fail: 0, unstructured: 0 };
  }

  let stats = { success: 0, fail: 0, unstructured: 0 };

  for (const ev of events) {
    try {
      logger.info(`[DevDistiller] 处理 L0 id=${ev.id}...`);
      const prompt = buildPrompt(ev);
      
      const res = await modelProvider.route('distill', prompt, { temperature: 0.1 });
      const parsed = extractJSON(res.content);

      if (!parsed || parsed.reusable === false || !parsed.problem || !parsed.solution) {
        logger.warn(`[DevDistiller] L0 id=${ev.id} 解析失败或无复用价值，降级`);
        dm.markUnstructured([ev.id]);
        stats.unstructured++;
        continue;
      }

      const exp = dm.writeExperience({
        sourceEventId: ev.id,
        taskType: parsed.task_type || ev.task_type || 'note',
        problem: parsed.problem,
        solution: parsed.solution,
        filesTouched: parsed.files_touched || ev.files_touched || [],
      });

      await dm.syncExperienceToVector(exp.id);
      dm.markDistilled([ev.id]);
      stats.success++;
      
    } catch (e) {
      logger.error(`[DevDistiller] L0 id=${ev.id} 异常: ${e.message}`);
      stats.fail++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  logger.info(`[DevDistiller] 蒸馏完成: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = { distillPending, _buildPrompt: buildPrompt, _extractJSON: extractJSON };
