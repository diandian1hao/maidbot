// core/modelProvider.js
// 统一多模型路由层：选 provider → 调用（含 1 次重试）→ 失败降级
const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');

const PROVIDERS = {
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey:  process.env.DEEPSEEK_API_KEY,
    defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    timeout: 30000,
    enabled: true,
  },
  glm: {
    baseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    apiKey:  process.env.GLM_API_KEY,
    defaultModel: process.env.GLM_MODEL || 'glm-4-flash',
    timeout: 15000,
    enabled: true,
  },
  qwen: {
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey:  process.env.QWEN_API_KEY,
    defaultModel: process.env.QWEN_MODEL || 'qwen-coder-turbo',
    timeout: 60000,
    enabled: true,
  },
  local: {
    baseUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
    apiKey: 'local',
    defaultModel: process.env.LOCAL_LLM_MODEL || 'qwen3-coder',
    timeout: 120000,
    enabled: false,
  },
};

const TASK_ROUTER = {
  chat:         'deepseek',
  write_code:   'deepseek',
  review_code:  'glm',
  distill:      'glm',
  analyze_long: 'qwen',
};

async function route(taskType, messages, opts = {}) {
  const primary = opts.provider || TASK_ROUTER[taskType] || 'deepseek';
  const tried = [];  // 只记录「真正发起过请求」的 provider
  const chain = [primary, ...['glm', 'deepseek', 'qwen'].filter(n => n !== primary)];

  for (const name of chain) {
    if (tried.length >= 2) break;  // 最多真实请求 2 个 provider

    const provider = PROVIDERS[name];
    // 🔧 修复：无效/禁用/无 Key 的 provider 跳过，但不占用降级名额
    if (!provider || provider.enabled === false) {
      logger.warn(`[ModelProvider] 跳过未知/禁用 provider: ${name}`);
      continue;
    }
    if (!provider.apiKey) {
      logger.warn(`[ModelProvider] ${name} 未配置 API Key，跳过`);
      continue;
    }

    tried.push(name);  // 只有真正要发请求时才计入
    try {
      return await callProvider(name, provider, messages, taskType, opts);
    } catch (e) {
      logger.warn(`[ModelProvider] ${name} 失败: ${e.message}，尝试降级`);
    }
  }

  throw new Error(`[ModelProvider] 所有 provider 均不可用 (tried: ${tried.join(',')})`);
}

async function callProvider(name, provider, messages, taskType, opts, maxRetries = 1) {
  const payload = {
    model: opts.model || provider.defaultModel,
    messages: normalizeMessages(messages),
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2000,
    stream: false,
  };

  const start = Date.now();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.post(`${provider.baseUrl}/chat/completions`, payload, {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: opts.timeout || provider.timeout,
      });

      const latency = Date.now() - start;
      const content = resp.data?.choices?.[0]?.message?.content || '';
      const usage = resp.data?.usage || {};
      logger.info(
        `[ModelProvider] ✅ ${name}/${payload.model} task=${taskType} latency=${latency}ms tokens=${usage.total_tokens ?? '?'}`
      );
      return { content, provider: name, model: payload.model, usage, latency };
    } catch (e) {
      const status = e.response?.status;
      const isRetryable = !status || status >= 500 || status === 429;
      if (!isRetryable || attempt === maxRetries) throw e;
      const delay = 1500;
      logger.warn(`[ModelProvider] ${name} status=${status}，${delay}ms 后重试`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function normalizeMessages(messages) {
  if (typeof messages === 'string') return [{ role: 'user', content: messages }];
  if (Array.isArray(messages)) return messages;
  if (messages && messages.role && messages.content) return [messages];
  throw new Error('[ModelProvider] 无法识别的 messages 格式');
}

function status() {
  return Object.entries(PROVIDERS).map(([name, p]) => ({
    name,
    enabled: p.enabled !== false,
    hasKey: !!p.apiKey,
    model: p.defaultModel,
  }));
}

module.exports = { route, status, PROVIDERS, TASK_ROUTER };
