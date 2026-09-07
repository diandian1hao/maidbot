// llm.js - 傲娇女仆的大脑（prompt 外置 + 可热重载 + 记忆注入）
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const logger = require('./utils/logger');

const API_KEY    = process.env.DEEPSEEK_API_KEY;
const BASE_URL   = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const MODEL      = process.env.LLM_MODEL || 'deepseek-chat';
const PROMPT_FILE = path.join(__dirname, 'prompts', 'maid.txt');

// ========== 人格管理 ==========
let currentPersona = { name: 'maid', systemPrompt: '' };

function loadPersona(filePath = PROMPT_FILE) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    currentPersona = {
      name: path.basename(filePath, '.txt'),
      systemPrompt: raw,
    };
    logger.info(`[LLM] 人格已加载: ${currentPersona.name} (${raw.length} chars)`);
  } catch (e) {
    logger.error(`[LLM] 读取人格文件失败: ${e.message} -> 使用内置默认`);
    currentPersona.systemPrompt = '你是一个傲娇女仆，嘴上毒舌但内心关心主人。';
  }
}

function switchPersona(filePath) {
  loadPersona(filePath);
  return currentPersona.name;
}

function getCurrentPersona() {
  return currentPersona;
}

// 启动时加载一次
loadPersona();

// ========== P0: 带指数退避重试的 axios 封装 ==========
async function postWithRetry(payload, opts = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.post(`${BASE_URL}/v1/chat/completions`, payload, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        ...opts,
      });
    } catch (err) {
      const status = err.response?.status;
      // 4xx(除429)是参数/鉴权错误，重试无意义；5xx/429/网络错误才重试
      const isRetryable = !status || status >= 500 || status === 429;
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      logger.warn(`[LLM] 请求失败(status=${status || err.message})，${delay}ms 后第${attempt + 1}次重试...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ========== 聊天主函数 ==========
async function chat(userMsg, options = {}) {
  const { history = [], summary = '', time = '' } = options;

  if (!API_KEY) {
    logger.error('[LLM] 缺少 DEEPSEEK_API_KEY，请检查 .env');
    return '主人，我的脑子空空的...（API Key 缺失）';
  }

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
    const res = await postWithRetry({
      model: MODEL,
      messages,
      temperature: 0.8,
      max_tokens: 500,
    });
    const reply = res.data.choices[0].message.content;
    logger.info(`[LLM] 回复生成成功 (${reply.length} chars)`);
    return reply;
  } catch (err) {
    logger.error(`[LLM] DeepSeek 调用失败(已耗尽重试): ${JSON.stringify(err.response?.data) || err.message}`);
    return '呜...DeepSeek 那个家伙不理我，请稍后再试。（API 调用失败）';
  }
}

// ========== 滚动总结 ==========
async function summarize(evictedMessages, previousSummary = '') {
  if (!API_KEY) return previousSummary;

  const evictedText = evictedMessages
    .map(m => `${m.role === 'user' ? '主人' : '女仆'}: ${m.content}`)
    .join('\n');

  const prompt = `你是一个记忆归档助手。请将以下对话片段压缩为一段简洁的长期记忆摘要（100字以内），保留关键事实、偏好和情感线索。

${previousSummary ? `已有长期记忆：\n${previousSummary}\n\n` : ''}新增对话片段：
${evictedText}

请输出更新后的长期记忆摘要：`;

  try {
    const res = await postWithRetry({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    }, {}, 2); // 总结失败不那么致命，重试2次即可
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    logger.error(`[LLM] 总结失败(已耗尽重试): ${e.message}`);
    return previousSummary;
  }
}

module.exports = { chat, switchPersona, getCurrentPersona, summarize };
