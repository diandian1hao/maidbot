const dm = require('./devMemory');
const modelProvider = require('./modelProvider');
const logger = require('../utils/logger');

async function devChat(query, opts = {}) {
  const userId = opts.userId || 'dev_me';
  const projectName = opts.projectName || 'default_project';
  const groupName = opts.groupName || 'common';
  const isIteration = opts.isIteration || false;
  const contextCode = opts.contextCode || '';
  let snapshotContext = '';
  try {
    const snap = dm._raw.prepare('SELECT snapshot_json FROM dev_snapshot WHERE user_id = ? AND group_name = ? AND project_name = ?').get(userId, groupName, projectName);
    if (snap && snap.snapshot_json) snapshotContext = snap.snapshot_json;
  } catch(e) {}

  logger.info(`[DevPipeline] 任务处理 -> 项目组:${groupName} | 项目:${projectName}`);

  // 1. 注入 L3 宪法 (🆕 补全 groupName 参数)
  let projectConstitution = '';
  try {
    const ctx = dm.getProjectContext(userId, groupName, projectName);
    if (ctx) projectConstitution = `【项目核心架构宪法 - 不可违背】\n${ctx}\n\n`;
  } catch (e) {}

  // 2. 混合联邦检索
  let l1Context = '';
  if (!isIteration) {
    try {
      let rawHits = [];
      if (groupName === 'common') {
        rawHits = dm._raw.prepare("SELECT * FROM dev_experience WHERE reusable = 1 AND (audit_status IS NULL OR audit_status != 'rejected') AND group_name = 'common'").all();
      } else {
        rawHits = dm._raw.prepare(`SELECT * FROM dev_experience WHERE reusable = 1 AND (audit_status IS NULL OR audit_status != 'rejected') AND (project_name = ? OR group_name = ? OR group_name = 'common')`).all(projectName, groupName);
      }

      const cleanQuery = query.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, ' ').trim();
      const keywords = cleanQuery.split(/\s+/).filter(w => w.length >= 2);
      if (keywords.length === 1 && keywords[0].length > 6) keywords.push(keywords[0].slice(0, 4));

      let ftsHits = [];
      if (keywords.length > 0) {
        const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ');
        try {
          if (groupName === 'common') {
             ftsHits = dm._raw.prepare(`SELECT e.* FROM dev_experience_fts f JOIN dev_experience e ON f.rowid = e.id WHERE dev_experience_fts MATCH ? AND e.reusable = 1 AND (e.audit_status IS NULL OR e.audit_status != 'rejected') AND e.group_name = 'common' LIMIT 5`).all(ftsQuery);
          } else {
             ftsHits = dm._raw.prepare(`SELECT e.* FROM dev_experience_fts f JOIN dev_experience e ON f.rowid = e.id WHERE dev_experience_fts MATCH ? AND e.reusable = 1 AND (e.audit_status IS NULL OR e.audit_status != 'rejected') AND (e.project_name = ? OR e.group_name = ? OR e.group_name = 'common') LIMIT 5`).all(ftsQuery, projectName, groupName);
          }
        } catch(e) {}
        
        ftsHits.forEach(h => { h.score = 0.95; });
        rawHits = [...rawHits, ...ftsHits];
      }

      const uniqueMap = new Map();
      rawHits.forEach(h => {
        const baseScore = h.score !== undefined ? h.score : 0.5;
        let finalScore = baseScore;
        if (h.project_name === projectName) finalScore *= 1.5;
        else if (h.group_name === groupName && h.group_name !== 'common') finalScore *= 1.2;
        
        h.finalScore = finalScore;
        if (!uniqueMap.has(h.id) || uniqueMap.get(h.id).finalScore < finalScore) {
          uniqueMap.set(h.id, h);
        }
      });

      const validHits = Array.from(uniqueMap.values()).filter(h => h.finalScore > 0.45).sort((a, b) => b.finalScore - a.finalScore);
      if (validHits.length > 0) {
        l1Context = validHits.slice(0, 3).map((h, i) => `【历史经验${i+1}】问题: ${h.problem}\n方案: ${h.solution}`).join('\n\n');
      }
    } catch (e) {}
  }

  let sysPrompt = `${projectConstitution}你是一个高级开发助手。请严格遵守上述项目宪法。\n`;
  sysPrompt += `【系统底座信息】\n你目前是 MaidBot 联邦系统中的 AI 核心。本系统基于 Node.js + SQLite + p3-vector 构建。\n\n`;
  if (snapshotContext) {
    try {
      const snapObj = JSON.parse(snapshotContext);
      const snapLines = [];
      if (snapObj.current_task) snapLines.push('- 当前任务：' + snapObj.current_task);
      if (snapObj.file_tree && snapObj.file_tree.length) snapLines.push('- 涉及文件：' + snapObj.file_tree.join(', '));
      if (snapObj.last_diff) snapLines.push('- 上轮产出：' + snapObj.last_diff);
      if (snapObj.recent_summary) snapLines.push('- 上轮结论：' + snapObj.recent_summary);
      if (snapObj.updated_at) snapLines.push('- 快照时间：' + Math.round((Date.now() - snapObj.updated_at) / 60000) + ' 分钟前');
      if (snapLines.length) {
        sysPrompt += '【当前项目状态快照（以此为准）】\n' + snapLines.join('\n') + '\n\n';
        logger.info('[DevPipeline] 快照注入 ' + snapLines.length + ' 行');
      }
    } catch (e) { sysPrompt += '【当前项目状态快照】\n' + snapshotContext + '\n\n'; }
  }
  if (l1Context) sysPrompt += `以下是与当前任务相关的历史经验（仅供参考，无关请忽略）：\n${l1Context}\n\n`;
  if (isIteration && contextCode) sysPrompt += `以下是当前正在修改的代码（黑板上一次的结果）：\n\`\`\`\n${contextCode}\n\`\`\`\n请在此基础上进行修改。\n`;

  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: query }
  ];

  // 4. 生成阶段
  logger.info(`[DevPipeline] 调用生成模型...`);
  const genRes = await modelProvider.route('write_code', messages, { temperature: 0.2 });

  // 5. 审查阶段
  logger.info(`[DevPipeline] 调用审查模型...`);
  let reviewRes = { content: '审查模型调用超时或异常，已跳过审查。', provider: 'system' };
  
  try {
    reviewRes = await modelProvider.route('review_code', [
      { role: 'system', content: '你是一个严苛的代码审查员，请指出潜在漏洞或最佳实践问题。' },
      { role: 'user', content: genRes.content }
    ], { temperature: 0.1, timeout: 60000 });
  } catch (e) {
    logger.error(`[DevPipeline] GLM 审查失败: ${e.message}，尝试紧急降级 DeepSeek 兜底审查...`);
    try {
      reviewRes = await modelProvider.route('write_code', [
        { role: 'system', content: '你是代码审查员，请简短审查以下代码是否有致命错误。' },
        { role: 'user', content: genRes.content }
      ], { temperature: 0.1, timeout: 30000 });
    } catch (e2) {
      logger.error(`[DevPipeline] 降级审查彻底失败: ${e2.message}`);
    }
  }

  // 6. 沉淀 L0
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
