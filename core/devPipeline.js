const dm = require('./devMemory');
const modelProvider = require('./modelProvider');
const logger = require('../utils/logger');

async function devChat(query, opts = {}) {
  const userId = opts.userId || 'dev_me';
  const projectName = opts.projectName || 'default_project';
  const groupName = opts.groupName || 'common';
  const isIteration = opts.isIteration || false;
  const contextCode = opts.contextCode || '';

  logger.info(`[DevPipeline] 任务处理 -> 项目组:${groupName} | 项目:${projectName}`);

  // 1. 注入 L3 宪法
  let projectConstitution = '';
  try {
    const ctx = dm.getProjectContext(userId, projectName);
    if (ctx) projectConstitution = `【项目核心架构宪法 - 不可违背】\n${ctx}\n\n`;
  } catch (e) {}

  // 2. 混合联邦检索 (向量语义 + FTS5 关键词)
  let l1Context = '';
  if (!isIteration) {
    try {
      let rawHits = [];
      
      // A. 获取当前组可用的所有经验
      if (groupName === 'common') {
        rawHits = dm._raw.prepare("SELECT * FROM dev_experience WHERE reusable = 1 AND group_name = 'common'").all();
      } else {
        rawHits = dm._raw.prepare(`SELECT * FROM dev_experience WHERE reusable = 1 AND (project_name = ? OR group_name = ? OR group_name = 'common')`).all(projectName, groupName);
      }

      // 🆕 B. FTS5 智能拆词检索
      // 长句在 FTS5 里会匹配失败，所以把查询词中的“废话”过滤，提取 2 个字以上的词块
      const cleanQuery = query.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, ' ').trim();
      const keywords = cleanQuery.split(/\s+/).filter(w => w.length >= 2);
      // 如果全是长句连在一起没有空格，简单粗暴地截取前 5 个字作为关键词尝试
      if (keywords.length === 1 && keywords[0].length > 6) {
         keywords.push(keywords[0].slice(0, 4));
      }

      let ftsHits = [];
      if (keywords.length > 0) {
        // 用 OR 连接关键词（例如匹配包含 "双库" 或 "Worker" 的经验）
        const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ');
        try {
          if (groupName === 'common') {
             ftsHits = dm._raw.prepare(`
               SELECT e.* FROM dev_experience_fts f 
               JOIN dev_experience e ON f.rowid = e.id 
               WHERE dev_experience_fts MATCH ? AND e.reusable = 1 AND e.group_name = 'common' LIMIT 5
             `).all(ftsQuery);
          } else {
             ftsHits = dm._raw.prepare(`
               SELECT e.* FROM dev_experience_fts f 
               JOIN dev_experience e ON f.rowid = e.id 
               WHERE dev_experience_fts MATCH ? AND e.reusable = 1 AND (e.project_name = ? OR e.group_name = ? OR e.group_name = 'common') LIMIT 5
             `).all(ftsQuery, projectName, groupName);
          }
        } catch(e) {
          logger.warn(`[DevPipeline] FTS5 拆词检索异常: ${e.message}`);
        }
        
        // 命中 FTS5 的，给予极高权重
        ftsHits.forEach(h => { h.score = 0.95; });
        rawHits = [...rawHits, ...ftsHits];
      }

      // C. 合并去重 + 排序
      const uniqueMap = new Map();
      rawHits.forEach(h => {
        // 赋予基础分（如果是从全量里捞的，给 0.5）
        const baseScore = h.score !== undefined ? h.score : 0.5;
        let finalScore = baseScore;
        
        if (h.project_name === projectName) finalScore *= 1.5;
        else if (h.group_name === groupName && h.group_name !== 'common') finalScore *= 1.2;
        
        h.finalScore = finalScore;
        
        if (!uniqueMap.has(h.id) || uniqueMap.get(h.id).finalScore < finalScore) {
          uniqueMap.set(h.id, h);
        }
      });

      const validHits = Array.from(uniqueMap.values())
        .filter(h => h.finalScore > 0.45)
        .sort((a, b) => b.finalScore - a.finalScore);

      if (validHits.length > 0) {
        l1Context = validHits.slice(0, 3).map((h, i) => `【历史经验${i+1}】问题: ${h.problem}\n方案: ${h.solution}`).join('\n\n');
        logger.info(`[DevPipeline] 混合检索命中 ${validHits.length} 条经验`);
      }
    } catch (e) {
      logger.warn(`[DevPipeline] 检索异常: ${e.message}`);
    }
  }

  // 3. 拼装 Prompt
  let sysPrompt = `${projectConstitution}你是一个高级开发助手。请严格遵守上述项目宪法。\n`;
  sysPrompt += `【系统底座信息】\n你目前是 MaidBot 联邦系统中的 AI 核心。本系统基于 Node.js + SQLite + p3-vector 构建。\n\n`;
  
  if (l1Context) sysPrompt += `以下是与当前任务相关的历史经验（仅供参考，无关请忽略）：\n${l1Context}\n\n`;
  if (isIteration && contextCode) sysPrompt += `以下是当前正在修改的代码（黑板上一次的结果）：\n\`\`\`\n${contextCode}\n\`\`\`\n请在此基础上进行修改。\n`;

  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: query }
  ];

  // 4. 生成与审查
  const genRes = await modelProvider.route('write_code', messages, { temperature: 0.2 });

  let reviewRes = { content: '跳过审查', provider: 'none' };
  try {
    reviewRes = await modelProvider.route('review_code', [
      { role: 'system', content: '你是一个严苛的代码审查员，请指出潜在漏洞或最佳实践问题。' },
      { role: 'user', content: genRes.content }
    ], { temperature: 0.1 });
  } catch (e) {
    logger.error(`[DevPipeline] 审查模型调用失败: ${e.message}`);
  }

  // 5. 沉淀 L0
  try {
    dm.writeEvent({
      source: 'devPipeline', groupName, projectName, taskType: 'write_code',
      rawInput: query, rawOutput: genRes.content, outcome: isIteration ? 'failed' : 'success'
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
