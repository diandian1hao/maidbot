// llm.js - 傲娇女仆的大脑（人格管理 + 记忆注入 + 委托 ModelProvider）
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const logger = require('./utils/logger');
const modelProvider = require('./core/modelProvider');

const PROMPT_FILE = path.join(__dirname, 'prompts', 'maid.txt');

// ========== 人格管理（原样保留）==========
let currentPersona = { name: 'maid', systemPrompt: '' };

function loadPersona(filePath = PROMPT_FILE) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    currentPersona = { name: path.basename(filePath, '.txt'), systemPrompt: raw };
    logger.info(`[LLM] 人格已加载: ${currentPersona.name} (${raw.length} chars)`);
  } catch (e) {
    logger.error(`[LLM] 读取人格文件失败: ${e.message} -> 使用内置默认`);
    currentPersona.systemPrompt = '你是一个傲娇女仆，嘴上毒舌但内心关心主人。';
  }
}

function switchPersona(filePath) { loadPersona(filePath); return currentPersona.name; }
function getCurrentPersona() { return currentPersona; }

loadPersona();

// ========== 聊天主函数（委托 ModelProvider，对外行为不变）==========
async function chat(userMsg, options = {}) {
  const { history = [], summary = '', time = '' } = options;

  let sysContent = currentPersona.systemPrompt;
  if (summary) sysContent += `\n\n【你对这位主人的长期记忆】\n${summary}`;
  if (time)    sysContent += `\n\n【当前时间】${time}`;

  const messages = [
    { role: 'system', content: sysContent },
    ...history.slice(-6),
    { role: 'user', content: userMsg },
  ];

  try {
    logger.info(`[LLM] 思考中: "${String(userMsg).substring(0, 20)}..."`);
    const r = await modelProvider.route('chat', messages, {
      temperature: 0.8,
      maxTokens: 500,
    });
    logger.info(`[LLM] 回复生成成功 (${r.content.length} chars, provider=${r.provider}, ${r.latency}ms)`);
    return r.content;
  } catch (err) {
    logger.error(`[LLM] 所有 provider 调用失败: ${err.message}`);
    return '呜...脑子转不动了，请稍后再试。（AI 服务暂时不可用）';
  }
}

// ========== 滚动总结（委托 ModelProvider，走 distill 路由到免费模型）==========
async function summarize(evictedMessages, previousSummary = '') {
  const evictedText = evictedMessages
    .map(m => `${m.role === 'user' ? '主人' : '女仆'}: ${m.content}`)
    .join('\n');

  const prompt = `你是一个记忆归档助手。请将以下对话片段压缩为一段简洁的长期记忆摘要（100字以内），保留关键事实、偏好和情感线索。

${previousSummary ? `已有长期记忆：\n${previousSummary}\n\n` : ''}新增对话片段：
${evictedText}

请输出更新后的长期记忆摘要：`;

  try {
    const r = await modelProvider.route('distill', prompt, {
      temperature: 0.3,
      maxTokens: 200,
    });
    return r.content.trim();
  } catch (e) {
    logger.error(`[LLM] 总结失败: ${e.message}`);
    return previousSummary;
  }
}

module.exports = { chat, switchPersona, getCurrentPersona, summarize };
