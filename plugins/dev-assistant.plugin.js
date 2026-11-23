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

  async handleMessage(msgData) {
    const text = (msgData.content || '').trim();
    const userId = msgData.sender_id || msgData.author?.user_openid || 'unknown';
    
    if (!text.startsWith('/dev')) return null;
    const subCmd = text.slice(4).trim();

    // ================= 系统级指令区 =================
    
    // 1. 状态查询
    if (subCmd === 'status') {
      const stats = dm.stats();
      const active = dm.getActiveSession(userId);
      const activeName = active ? `[${active.group_name}] ${active.project_name}` : '无 (请用 /dev use 开启)';
      return `📊 [知识库状态]\nL1 经验: ${stats.experience} 条\n📍 当前项目: ${activeName}`;
    }

    // 2. 清理缓存文件
    if (subCmd === 'clean') {
      try {
        const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.md'));
        let deleted = 0;
        for (const f of files) {
          const fp = path.join(OUTPUT_DIR, f);
          if (Date.now() - fs.statSync(fp).mtimeMs > 24 * 3600 * 1000) {
            fs.unlinkSync(fp);
            deleted++;
          }
        }
        return `🧹 清理完成！共删除 ${deleted} 个过期文件。`;
      } catch (e) {
        return `❌ 清理失败: ${e.message}`;
      }
    }

    // 3. 切换项目
    if (subCmd.startsWith('use ')) {
      const targetProject = subCmd.slice(4).trim();
      dm.switchProjectWorkspace(userId, targetProject);
      return `✅ 已锁定项目空间: [${targetProject}]`;
    }

    // 4. 归档并蒸馏
    if (subCmd === 'done') {
      const active = dm.getActiveSession(userId);
      if (active) {
        dm.markProjectDone(userId, active.project_name);
        return `✅ 项目 [${active.project_name}] 已归档，黑板已清空，经验已送入蒸馏队列。`;
      }
      return '当前没有活跃项目。';
    }

    // 5. 记录架构宪法 (带群组隔离)
    if (subCmd.startsWith('adr ')) {
      const active = dm.getActiveSession(userId);
      if (!active) return '⚠️ 请先用 /dev use 选择项目。';
      
      const adrText = subCmd.slice(4).trim();
      const oldCtx = dm.getProjectContext(userId, active.group_name, active.project_name) || '';
      const newCtx = oldCtx + `\n- ${adrText}`;
      dm.updateProjectContext(userId, active.group_name, active.project_name, newCtx);
      
      const lines = newCtx.trim().split('\n').length;
      return `✅ 已记录架构决策到 [${active.project_name}] 的宪法中。\n📝 最新记录: ${adrText}\n📊 当前宪法共 ${lines} 条。`;
    }

    // 6. 手动记笔记（静默写入，不调大模型）
    if (subCmd.startsWith('note ')) {
      const active = dm.getActiveSession(userId);
      if (!active) return '⚠️ 请先用 /dev use <项目名> 选择项目。';
      
      const noteContent = subCmd.slice(5).trim();
      dm.writeEvent({
        source: 'manual_note',
        groupName: active.group_name,
        projectName: active.project_name,
        taskType: 'note',
        rawInput: noteContent,
        rawOutput: '手动沉淀的笔记，等待自动蒸馏。',
        outcome: 'success'
      });
      return `✅ 笔记已静默写入 L0 原始库。系统将在 30 分钟内自动蒸馏为 L1 经验。`;
    }

    // ================= 核心开发区 =================
    if (!subCmd) return '💡 /dev use 切换 | /dev note 记笔记 | /dev adr 宪法 | /dev done 归档\n/dev <需求> 直接开发';

    const active = dm.getActiveSession(userId);
    if (!active) return '⚠️ 请先 /dev use <项目名> 进入项目。';

    const isIteration = /报错|修改|不对|错误|换个|改成|优化|重写|继续/i.test(subCmd);
    const contextCode = isIteration ? (active.last_code || '') : '';

    try {
      logger.info(`[DevAssistant] 收到 QQ /dev 指令: "${subCmd}"`);
      const result = await devChat(subCmd, {
        userId,
        groupName: active.group_name,
        projectName: active.project_name,
        isIteration,
        contextCode
      });

      // 更新黑板
      dm.updateSessionCode(userId, active.project_name, result.reply);

      // 排版组装
      let header = `📍 [项目组: ${active.group_name} | 项目: ${active.project_name}]\n`;
      header += `✅ 生成: ${result.provider} | 审查: ${result.reviewer} (${(result.latency/1000).toFixed(1)}s)\n\n`;
      
      let code = result.reply.replace(/```[a-z]*/g, '').replace(/```/g, '');
      let review = result.review.slice(0, 200) + (result.review.length > 200 ? '...' : '');

      // 落盘完整版
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `dev_${ts}.md`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), 
        `【项目组】: ${active.group_name}\n【项目】: ${active.project_name}\n【生成】: ${result.provider}\n【审查】: ${result.reviewer}\n\n--- 代码 ---\n${result.reply}\n\n--- 审查 ---\n${result.review}`, 'utf-8');

      const webUrl = `${process.env.PUBLIC_WEB_URL || 'http://127.0.0.1:3001'}/dev-files/${filename}`;
      let shortCode = code.length > 400 ? code.slice(0, 400) + '\n... (代码已截断)' : code;

      let finalReply = `${header}💻 代码:\n${shortCode}\n\n🔍 审查:\n${review}\n\n`;
      finalReply += `📄 完整版网页预览:\n👉 ${webUrl}\n\n`;
      finalReply += `👉 有报错请直接回复 /dev <报错内容>，没问题请回复 /dev done`;

      if (finalReply.length > 1500) {
        finalReply = finalReply.slice(0, 1450) + '...\n(内容过长已截断)';
      }

      return finalReply;
      
    } catch (e) {
      logger.error(`[DevAssistant] 执行失败: ${e.message}`);
      return `❌ 开发任务失败: ${e.message}`;
    }
  }
}

module.exports = DevAssistant;
