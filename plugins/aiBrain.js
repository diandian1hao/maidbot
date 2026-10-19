// plugins/aiBrain.js - AI 大脑插件（接入 LLM + Memory + 滚动总结 + RAG 消费）
const { chat, summarize } = require('../llm');
const memory = require('../core/memory');

class AIBrain {
  constructor(bot) {
    this.name = 'aiBrain';
    this.priority = 999; // ⭐ 兜底插件，最后执行
    this.bot = bot;
    console.log('[AIBrain] 🧠 AI 插件已就绪 (RAG Enabled)');
  }

  async handleMessage(msgData, botInstance) {
    const userId = msgData.sender_id || msgData.author?.user_openid;
    const text   = (msgData.content || '').trim();
    if (!userId || !text) return null;

    // 🆕 Step 1b: 消费 RAG 上下文
    let enhancedText = text;
    const ragResults = msgData.context?.ragResults;
    if (ragResults && ragResults.length > 0) {
      const ragContext = ragResults
        .map((r, i) => `[参考${i + 1}] ${r.content || r.text || JSON.stringify(r)}`)
        .join('\n');
      enhancedText = `【参考资料】\n${ragContext}\n\n【用户问题】\n${text}`;
      console.log(`[AIBrain] 📚 注入 ${ragResults.length} 条 RAG 上下文`);
    }

    // 1. 带记忆 + 时间感知 + RAG 上下文调用 LLM
    const nowStr = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });

    const answer = await chat(enhancedText, {
      history: memory.getHistory(userId),
      summary: memory.getSummary(userId),
      time: nowStr,
    });

    // 2. 写入短期记忆；溢出部分异步总结成长期记忆
    memory.append(userId, 'user', text);
    const evicted = memory.append(userId, 'assistant', answer);

    if (evicted && evicted.length) {
      const oldSum = memory.getSummary(userId);
      summarize(evicted, oldSum)
        .then(sum => {
          memory.setSummary(userId, sum);
          memory.pruneAfterSummary(userId);
          console.log('[AIBrain] 📝 长期记忆已归档');
        })
        .catch(e => console.error('[AIBrain] ⚠️ 总结失败(不致命):', e.message));
    }

    return answer;
  }
}

module.exports = AIBrain;
