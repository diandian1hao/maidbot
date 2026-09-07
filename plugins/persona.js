// plugins/persona.js - /人格 指令插件（热切换人格）
const { switchPersona, getCurrentPersona } = require('../llm');
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

class PersonaPlugin {
  constructor(bot) {
    this.name = 'persona';
	this.priority = 10;
  }

  async handleMessage(msgData) {
    const text = (msgData.content || '').trim();
    if (!text.startsWith('/人格')) return null;

    const arg = text.replace('/人格', '').trim();

    // 列出可用人格
    if (!arg || arg === 'list') {
      try {
        const files = fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.txt'));
        const current = getCurrentPersona().name;
        const list = files.map(f => f.replace('.txt', '')).join(', ');
        return `🎭 可用人格：${list}\n当前：${current}`;
      } catch (e) {
        return '❌ 读取人格目录失败: ' + e.message;
      }
    }

    // 切换人格
    const target = path.join(PROMPTS_DIR, `${arg}.txt`);
    if (!fs.existsSync(target)) {
      return `❌ 未找到人格「${arg}」，发送 /人格 list 查看可用列表`;
    }

    const name = switchPersona(target);
    return `✅ 已切换为「${name}」人格！（哼，别以为换个脸我就对你温柔了）`;
  }
}

module.exports = PersonaPlugin;
