// core/patternDistiller.js —— 将高频使用的 L1 向上蒸馏为通用规律 L2
const dm = require('./devMemory');
const modelProvider = require('./modelProvider');
const logger = require('../utils/logger');

async function checkAndDistillL2() {
  // 找出使用次数 >= 3 且还没蒸馏过 L2 的经验（这里简单用 used_count==3 作为触发点，避免重复执行）
  const candidates = dm._raw.prepare(
    'SELECT * FROM dev_experience WHERE used_count = 3 AND reusable = 1'
  ).all();

  if (candidates.length === 0) return;

  logger.info(`[PatternDistiller] 发现 ${candidates.length} 条高频经验，开始提取通用规律...`);

  for (const c of candidates) {
    try {
      const prompt = `以下是一条高频使用的开发经验，请提取出更通用的架构设计规律或编程原则。
【具体经验】
问题: ${c.problem}
方案: ${c.solution}

【输出要求】
输出简洁的 JSON：
{"pattern": "提取出的通用规律(不超过100字)", "confidence": 0.8}`;

      const res = await modelProvider.route('distill', prompt, { temperature: 0.1 });
      const text = res.content;
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        
        // 写入 L2 表
        dm._raw.prepare(
          'INSERT INTO dev_patterns (ts, pattern, evidence_ids, confidence) VALUES (?, ?, ?, ?)'
        ).run(Date.now(), parsed.pattern, JSON.stringify([c.id]), parsed.confidence || 0.8);

        logger.info(`[PatternDistiller] 🌟 L1 id=${c.id} 成功升华为 L2: ${parsed.pattern}`);
      }
    } catch (e) {
      logger.error(`[PatternDistiller] 处理 L1 id=${c.id} 失败: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

module.exports = { checkAndDistillL2 };
