// core/devPipeline.js —— W4 真正的 Pipeline 架构：分步编排 + 自动沉淀闭环
const dm = require('./devMemory');
const modelProvider = require('./modelProvider');
const logger = require('../utils/logger');

// 步骤 1：精排算法
function rankHits(hits) {
  const now = Date.now();
  return hits.map(h => {
    const daysOld = (now - h.ts) / (1000 * 60 * 60 * 24);
    const recencyWeight = Math.max(0.5, 1 - (daysOld / 10) * 0.1);
    const adoptedBonus = h.adopted === 1 ? 0.3 : 0;
    h.finalScore = (h.score * 0.6) + (recencyWeight * 0.2) + (adoptedBonus * 0.2);
    return h;
  }).sort((a, b) => b.finalScore - a.finalScore);
}

// 步骤 2：记忆检索
async function memoryRecall(input) {
  try {
    const rawHits = await dm.searchExperience(input, { topK: 5 });
    if (rawHits.length === 0) return '无相关历史经验。';
    const ranked = rankHits(rawHits).slice(0, 3);
    return ranked.map((h, i) => `【经验${i+1}】问题: ${h.problem}\n方案: ${h.solution}`).join('\n\n');
  } catch (e) {
    logger.warn(`[DevPipeline] 检索失败: ${e.message}`);
    return '无相关历史经验。';
  }
}

// 步骤 3：主流程编排
async function devChat(input) {
  logger.info(`[DevPipeline] 🚀 开始处理任务: "${input}"`);

  // 1. 召回
  const contextStr = await memoryRecall(input);

  // 2. 生成
  logger.info(`[DevPipeline] ⚙️ 调用生成模型...`);
  const genMessages = [
    { role: 'system', content: `你是一个高级开发助手。请结合以下历史经验来回答用户的问题。\n\n${contextStr}` },
    { role: 'user', content: input }
  ];
  const genRes = await modelProvider.route('write_code', genMessages, { temperature: 0.2 });

  // 3. 审查
  logger.info(`[DevPipeline] 🔍 调用审查模型...`);
  const reviewMessages = [
    { role: 'system', content: '你是一个严苛的代码审查员。请检查以下回答/代码是否存在逻辑错误、安全漏洞或违背最佳实践的地方。如果没问题，请回复“通过”；有问题请直接指出。' },
    { role: 'user', content: genRes.content }
  ];
  let reviewRes = { content: '跳过审查', provider: 'none' };
  try {
    reviewRes = await modelProvider.route('review_code', reviewMessages, { temperature: 0.1 });
  } catch (e) {
    logger.warn(`[DevPipeline] 审查异常: ${e.message}`);
  }

  // 4. 闭环沉淀（关键一步！）
  // 如果审查通过了，或者哪怕只是给了建议，我们把这次的输入输出打包成 L0 存起来。
  // 系统会在 30 分钟内自动把它蒸馏成新的 L1 经验。
  try {
    // 🆕 注入模型元数据，让未来的记忆知道这次是谁生成、谁审查的
    const metaHeader = `【生成模型】: ${genRes.provider} (${genRes.model})\n【审查模型】: ${reviewRes.provider || 'none'}\n\n`;
    
    dm.writeEvent({
      source: 'devPipeline',
      taskType: 'write_code',
      rawInput: input,
      rawOutput: `${metaHeader}【代码/方案】\n${genRes.content}\n\n【审查意见】\n${reviewRes.content}`,
      outcome: 'success'
    });
    logger.info(`[DevPipeline] 💾 已将本次开发记录（含模型印记）沉淀回 L0`);
  } catch (e) {
    logger.warn(`[DevPipeline] 沉淀 L0 失败: ${e.message}`);
  }

  return {
    reply: genRes.content,
    review: reviewRes.content,
    provider: genRes.provider,
    reviewer: reviewRes.provider,
    latency: genRes.latency + (reviewRes.latency || 0)
  };
}

module.exports = { devChat };
