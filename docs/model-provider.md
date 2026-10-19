# ModelProvider 多模型路由层

## 概述

统一封装 DeepSeek / GLM / Qwen 的调用，提供任务路由、失败降级、超时重试。业务方只调 route()，不用关心具体哪家 API。

## 路由表

| 任务类型 | 默认 provider | 用途 |
|---------|--------------|------|
| chat | deepseek | 聊天对话 |
| write_code | deepseek | 代码生成 |
| review_code | glm | 代码审查（与生成用不同模型） |
| distill | glm | 经验蒸馏（免费模型） |
| analyze_long | qwen | 长上下文分析 |

## 降级链

primary → 依次尝试 glm → deepseek → qwen，最多真实请求 2 个 provider。

未知 / 禁用 / 无 Key 的 provider 会跳过，不占用降级名额。

## 使用方式

    const mp = require('./core/modelProvider');
    const r = await mp.route('chat', messages, { temperature: 0.7, maxTokens: 500 });
    // r = { content, provider, model, usage, latency }

## 切换 / 扩展

- 默认路由：改 TASK_ROUTER
- 强制指定：route(task, msg, { provider: 'glm' })
- 临时换模型：route(task, msg, { model: 'glm-4-plus' })
- 新增 provider：在 PROVIDERS 加一项，.env 加 Key，按需绑 TASK_ROUTER

## 测试

    node scripts/test-model-provider.js

覆盖：默认路由 / 异模型路由 / 强制 provider / 降级链。

## 已知隐患（W4 前处理）

- GLM review_code 长输出 latency 13-14s：不是冷启动（测试 3/4 同模型只要 2-3s），是 review_code 输出 200+ tokens + 长 prompt 导致的。devPipeline 审查环节必须设 timeout=10000 兜底，超时降级 DeepSeek。
- 单次聊天 tokens≈1666（RAG 3 条 + 长期记忆 + 人格 prompt）：W7 加每日 token 预算上限。
