// core/devDistiller.js —— L0 -> L1 蒸馏胶水逻辑
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const modelProvider = require('./modelProvider');
const dm = require('./devMemory');

const PROMPT_FILE = path.join(__dirname, '../prompts/dev-distill.md');

// 读取模板并替换变量
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

// 从可能带有 markdown 语法的字符串中提取纯净 JSON
function extractJSON(text) {
  // 简单粗暴：找到第一个 { 和最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || start > end) return null;
  const jsonStr = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/**
 * 批量蒸馏
 * @param {number} limit 单次处理上限
 */
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
      const prompt = buildPrompt(ev);
      // TODO: 调 modelProvider.route('distill', prompt) 并处理结果
      // (留到明天写)
      
      logger.info(`[DevDistiller] 处理 L0 id=${ev.id} (暂存)`);
      
    } catch (e) {
      logger.error(`[DevDistiller] L0 id=${ev.id} 异常: ${e.message}`);
    }
  }

  return stats;
}

module.exports = {
  distillPending,
  // 导出用于测试
  _buildPrompt: buildPrompt,
  _extractJSON: extractJSON
};
