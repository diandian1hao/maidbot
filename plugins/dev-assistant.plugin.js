const fs = require('fs');
const path = require('path');
const { devChat } = require('../core/devPipeline');
const dm = require('../core/devMemory');

const OUTPUT_DIR = path.join(__dirname, '../logs/dev-output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

class DevAssistant {
  constructor(bot) { this.name = 'dev-assistant'; this.priority = 5; this.bot = bot; }

  async handleMessage(msgData) {
    const text = (msgData.content || '').trim();
    const userId = msgData.sender_id || msgData.author?.user_openid || 'unknown';
    if (!text.startsWith('/dev')) return null;
    const subCmd = text.slice(4).trim();

    // ===== 帮助与看板区 =====
    if (!subCmd || subCmd === 'help') {
      const groups = dm.listUserGroups(userId);
      const active = dm.getActiveSession(userId);
      let activeText = active ? `[${active.group_name}] ${active.project_name}` : '未进入任何项目';
      
      let groupList = '';
      if (!groups.length) {
        groupList = '暂无项目组，请使用 /dev use <组名>/<项目名> 创建。';
      } else {
        groupList = groups.map(g => `📁 [${g.group_name}] (${g.project_count} 个项目)`).join('\n');
      }

      return `🤖 **MaidBot 开发助手控制台**\n\n` +
             `📍 **当前所在:** ${activeText}\n\n` +
             `🗂️ **项目组概览:**\n${groupList}\n\n` +
             `🛠️ **指令说明书:**\n` +
             `• \`/dev use <组名>/<项目名>\` - 进入/创建项目\n` +
             `• \`/dev ls\` - 查看所有项目组\n` +
             `• \`/dev ls <组名>\` - 查看该组下所有项目\n` +
             `• \`/dev adr <文字>\` - 记录架构决策(宪法)\n` +
             `• \`/dev done\` - 归档并清空当前项目黑板\n` +
             `• \`/dev <需求>\` - 在当前项目开发代码\n\n` +
             `💡 *直接输入需求，系统会自动结合历史经验与项目宪法为您生成代码。*`;
    }

    if (subCmd === 'ls' || subCmd === 'list') {
      const groups = dm.listUserGroups(userId);
      if (!groups.length) return '还没有任何项目，输入 /dev use <组名>/<项目名> 开始。';
      const list = groups.map(g => `📁 [${g.group_name}] (${g.project_count} 个项目)`).join('\n');
      return `🗂️ 所有项目组:\n${list}\n\n💡 查看组内项目: /dev ls <组名>`;
    }

    if (subCmd.startsWith('ls ') || subCmd.startsWith('list ')) {
      const groupName = subCmd.split(' ')[1].trim();
      const projects = dm.listProjectsInGroup(userId, groupName);
      if (!projects.length) return `📁 项目组 [${groupName}] 下暂无项目。`;
      
      const list = projects.map(p => {
        const icon = p.is_active ? '👉 [当前]' : (p.status === 'completed' ? '✅ [已完成]' : '⏸️ [休眠]');
        return `${icon} ${p.project_name}`;
      }).join('\n');
      return `📂 项目组 [${groupName}] 下的项目:\n${list}\n\n💡 切换: /dev use ${groupName}/<项目名>`;
    }

    if (subCmd.startsWith('use ')) {
      const pName = subCmd.slice(4).trim();
      dm.switchProjectWorkspace(userId, pName);
      return `✅ 已进入项目空间: [${pName}]`;
    }

    if (subCmd === 'done') {
      const active = dm.getActiveSession(userId);
      if (active) {
        dm.markProjectDone(userId, active.project_name);
        return `✅ 项目 [${active.project_name}] 已归档，黑板已清空。`;
      }
      return '没有活跃的项目。';
    }

    if (subCmd.startsWith('adr ')) {
      const active = dm.getActiveSession(userId);
      if (!active) return '⚠️ 请先用 /dev use 选择项目。';
      const adrText = subCmd.slice(4).trim();
      const oldCtx = dm.getProjectContext(userId, active.project_name) || '';
      dm.updateProjectContext(userId, active.project_name, oldCtx + `\n- ${adrText}`);
      return `✅ 已记录架构决策到 [${active.project_name}]。`;
    }

    // ===== 核心开发区 =====

    const active = dm.getActiveSession(userId);
    if (!active) return '⚠️ 请先 /dev use <项目名> 进入项目。';

    const isIteration = /报错|修改|不对|错误|换个|改成|优化|重写|继续/i.test(subCmd);
    const contextCode = isIteration ? (active.last_code || '') : '';

    try {
      const result = await devChat(subCmd, {
        userId,
        groupName: active.group_name || 'common',
        projectName: active.project_name,
        isIteration,
        contextCode
      });

      dm.updateSessionCode(userId, active.project_name, result.reply);

      // 🆕 强制带上 [项目名] 标签
      let header = `📍 [项目组: ${active.group_name || 'common'} | 项目: ${active.project_name}]\n✅ 生成: ${result.provider} | 审查: ${result.reviewer}\n\n`;
      let code = result.reply.replace(/```[a-z]*/g, '');
      let shortCode = code.length > 400 ? code.slice(0, 400) + '\n... (已截断)' : code;
      
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `dev_${ts}.md`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), `【项目】: ${active.project_name}\n\n${result.reply}\n\n${result.review}`, 'utf-8');
      const webUrl = `${process.env.PUBLIC_WEB_URL || 'http://127.0.0.1:3001'}/dev-files/${filename}`;

      return `${header}💻 代码:\n${shortCode}\n\n📄 网页全览: ${webUrl}\n\n👉 报错请直接回复，没问题请回复 /dev done`;
    } catch (e) {
      return `❌ 开发失败: ${e.message}`;
    }
  }
}
module.exports = DevAssistant;
