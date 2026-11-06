const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { devChat } = require('../core/devPipeline');
const dm = require('../core/devMemory');

const OUTPUT_DIR = path.join(__dirname, '../logs/dev-output');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

class DevAssistant {
  constructor(bot) {
    this.name = 'dev-assistant';
    this.priority = 5;
    this.bot = bot;
    console.log('[DevAssistant] 🛠️ 开发助手插件已就绪');
  }

  async handleMessage(msgData, botInstance) {
    const text = (msgData.content || '').trim();
    if (!text.startsWith('/dev')) return null;

    const subCmd = text.slice(4).trim();
    if (!subCmd) return '💡 用法：\n/dev <开发需求>\n/dev status\n/dev clean';

    // 指令：查看状态
    if (subCmd === 'status') {
      const stats = dm.stats();
      return `📊 [知识库状态]\nL0 原始: ${stats.events}\nL1 经验: ${stats.experience}\n待蒸馏: ${stats.events - stats.distilled}`;
    }

    // 🆕 指令：清理临时输出文件
    if (subCmd === 'clean') {
      try {
        const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.md'));
        let deleted = 0;
        const now = Date.now();
        for (const f of files) {
          const fp = path.join(OUTPUT_DIR, f);
          const stat = fs.statSync(fp);
          // 清理超过 24 小时的文件
          if (now - stat.mtimeMs > 24 * 3600 * 1000) {
            fs.unlinkSync(fp);
            deleted++;
          }
        }
        return `🧹 清理完成！共删除 ${deleted} 个过期文件 (超过24小时)。`;
      } catch (e) {
        return `❌ 清理失败: ${e.message}`;
      }
    }

    // 核心生成任务
    try {
      logger.info(`[DevAssistant] 收到 QQ /dev 指令: "${subCmd}"`);
      const result = await devChat(subCmd);

      let code = result.reply.replace(/```[a-z]*/g, '').replace(/```/g, '');
      let review = result.review.replace(/```[a-z]*/g, '').replace(/```/g, '');
      let shortReview = review.length > 300 ? review.slice(0, 300) + '...' : review;

      const header = `✅ 任务完成！\n生成: ${result.provider}\n审查: ${result.reviewer} (耗时 ${(result.latency/1000).toFixed(1)}s)\n`;
      
      // 🆕 调整顺序：先代码，后审查
      let finalOutput = `${header}\n--- 核心代码/方案 ---\n${code}\n\n--- 审查意见 ---\n${shortReview}`;

      if (finalOutput.length > 1500) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `dev_${ts}.md`;
        fs.writeFileSync(path.join(OUTPUT_DIR, filename), 
          `【生成模型】: ${result.provider}\n【审查模型】: ${result.reviewer}\n\n--- 代码/方案 ---\n${result.reply}\n\n--- 审查意见 ---\n${result.review}`, 'utf-8');

        const shortCode = code.length > 1000 ? code.slice(0, 1000) + '\n...(已截断)' : code;
        
        finalOutput = `${header}\n--- 核心代码 (前1000字) ---\n${shortCode}\n\n--- 审查意见 ---\n${shortReview}\n\n📄 完整内容已存入:\nlogs/dev-output/${filename}`;
      }

      return finalOutput;
    } catch (e) {
      logger.error(`[DevAssistant] 执行失败: ${e.message}`);
      return `❌ 开发任务失败: ${e.message}`;
    }
  }
}

module.exports = DevAssistant;
