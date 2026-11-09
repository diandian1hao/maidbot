// core/devPipeline.js —— 核心编排层（接收明确意图，注入宪法和上下文）
const dm = require('./devMemory');
const modelProvider = require('./modelProvider');
const logger = require('../utils/logger');

// 精排逻辑
function rankHits(hits) {
  const now = Date.now();
  return hits.map(h => {
    const daysOld = (now - h.ts) / (1000 * 60 * 60 * 24);
    const recencyWeight = Math.max(0.5, 1 - (daysOld / 10) * 0.1);
    const adoptedBonus = h.adopted === 1 ? 0.3 : 0;
    const permanentBonus = h.is_permanent === 1 ? 0.2 : 0; // 🆕 永久经验加权
    h.finalScore = (h.score || 0) * 0.6 + recencyWeight * 0.2 + adoptedBonus * 0.1 + permanentBonus * 0.1;
    return h;
  }).sort((a, b) => b.finalScore - a.finalScore);
}

async function devChat(query, opts = {}) {
  const userId = opts.userId || 'default_user';
  const projectName = opts.projectName || 'default_project';
  const groupName = opts.groupName || 'common';
  const isIteration = opts.isIteration || false;
  const contextCode = opts.contextCode || '';

  logger.info(`[DevPipeline] 任务处理 -> 用户:${userId} | 项目:${projectName} | 迭代:${isIteration}`);

  // 1. 注入 L3 宪法（如果有）
  let projectConstitution = '';
  try {
    const ctx = dm.getProjectContext(userId, projectName);
    if (ctx) {
      projectConstitution = `【项目核心架构宪法 - 不可违背】\n${ctx}\n\n`;
    }
  } catch (e) {}

  // 2. 意图路由与 L1 检索（如果是迭代追问，跳过 L1 检索，避免污染）
  let l1Context = '';
  if (!isIteration) {
    try {
      // 🆕 联邦检索：拉取当前项目 + 全局，当前项目加权
      const rawHits = dm._raw.prepare('SELECT * FROM dev_experience WHERE reusable = 1').all(); 
      
      const validHits = rawHits.filter(h => (h.score || 0) > 0.45).map(h => {
        // 🆕 三级权重分配
        if (h.project_name === projectName) {
           h.score = (h.score || 0) * 1.5; // 当前项目：极度优先
        } else if (h.group_name === groupName && h.group_name !== 'common') {
           h.score = (h.score || 0) * 1.2; // 同组项目：次优先
        }
        return h;
      }).sort((a, b) => (b.score || 0) - (a.score || 0));
      if (validHits.length > 0) {
        l1Context = validHits.slice(0, 3).map((h, i) => `【历史经验${i+1}】问题: ${h.problem}\n方案: ${h.solution}`).join('\n\n');
      }
    } catch (e) {}
  }

  // 3. 拼装 Prompt
  let sysPrompt = `${projectConstitution}你是一个高级开发助手。请严格遵守上述项目宪法。\n`;
  if (l1Context) {
    sysPrompt += `以下是与当前任务相关的历史经验（仅供参考，无关请忽略）：\n${l1Context}\n\n`;
  }
  if (isIteration && contextCode) {
    sysPrompt += `以下是当前正在修改的代码（黑板上一次的结果）：\n\`\`\`\n${contextCode}\n\`\`\`\n请在此基础上进行修改。\n`;
  }

  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: query }
  ];

  // 4. 生成与审查
  logger.info(`[DevPipeline] 调用生成模型...`);
  const genRes = await modelProvider.route('write_code', messages, { temperature: 0.2 });

  logger.info(`[DevPipeline] 调用审查模型...`);
  let reviewRes = { content: '跳过审查', provider: 'none' };
  try {
    reviewRes = await modelProvider.route('review_code', [
      { role: 'system', content: '你是一个严苛的代码审查员，请指出潜在漏洞或最佳实践问题。' },
      { role: 'user', content: genRes.content }
    ], { temperature: 0.1 });
  } catch (e) {}

  // 5. 沉淀 L0
  try {
    const metaHeader = `【生成模型】: ${genRes.provider}\n【审查模型】: ${reviewRes.provider}\n\n`;
    dm.writeEvent({
      source: 'devPipeline',
      taskType: 'write_code',
      rawInput: query,
      rawOutput: `${metaHeader}【代码】\n${genRes.content}\n\n【审查】\n${reviewRes.content}`,
      outcome: isIteration ? 'failed' : 'success' // 粗略标记
    });
  } catch (e) {}

  return {
    reply: genRes.content,
    review: reviewRes.content,
    provider: genRes.provider,
    reviewer: reviewRes.provider,
    latency: (genRes.latency || 0) + (reviewRes.latency || 0)
  };
}

module.exports = { devChat };
