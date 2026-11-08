// plugins/schedule.js - 早午晚安 + 每日早报 + 记忆自动清理 (适配高密度天气数据版)
const { chat } = require('../llm');
const memory = require('../core/memory');

class SchedulePlugin {
  constructor(bot) {
    this.name = 'schedule';
    this.priority = 60;
    this.bot = bot;
    this._fired = new Set();
    this._startClock();
    console.log('[Schedule] ⏰ 定时插件已就绪（早报城市: ' + (process.env.OWNER_CITY || '北京') + '）');
  }

  async handleMessage() { return null; }

  _startClock() {
    const T    = (k, d) => process.env[k] || d;
    const CITY = () => process.env.OWNER_CITY || '北京';
    
    const TASKS = [
      // 🆕 优化：早安提示词，直接吃透详细的 w 数据
      { id: 'morning',     time: T('T_MORNING', '07:30'), p: w => `现在是早晨。向主人道早安，2-3句，自然带出今日天气情况：\n${w}` },
      
      // 🆕 优化：早报提示词，加入高密度天气解析和策略建议
      { id: 'daily',       time: T('T_DAILY',   '07:35'), p: w => `播报今日早报。请结合以下详细天气数据：\n${w}\n要求：先概括日期和今天气温，接着给出穿衣、带伞或防晒建议，最后提一句明日天气趋势。语气保持傲娇女仆风。` },
      
      { id: 'noon',        time: T('T_NOON',    '12:00'), p: () => '现在是中午。提醒主人吃饭休息，1-2句。' },
      { id: 'night',       time: T('T_NIGHT',   '22:30'), p: () => '现在是深夜。催主人早睡、道晚安，1-2句。' },
      { id: 'memory_clean', time: T('T_CLEAN',   '03:00'), p: null },
    ];

    const FALLBACK = {
      morning: `早安，主人！（打哈欠）今天${CITY()}的天气服务罢工了，但你的女仆在线。快起床！`,
      daily:   '今日早报：天气服务今天罢工，但你的女仆在线。主人今天也要顺利哦！',
      noon:    '主人，中午了，该吃饭了！别饿着。',
      night:   '夜深了，主人早点睡，晚安~',
    };

    this._timer = setInterval(() => {
      const now = new Date();
      const hm  = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
      const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

      for (const t of TASKS) {
        if (t.time !== hm || this._fired.has(t.id + day)) continue;
        this._fired.add(t.id + day);

        (async () => {
          if (t.id === 'memory_clean') {
            try {
              const count = memory.purgeExpired(); 
              console.log(`[Schedule] 🧹 [${hm}] 记忆自动清理完成，删除 ${count} 条过期数据`);
            } catch (e) {
              console.error('[Schedule] ⚠️ 记忆清理失败:', e.message);
            }
            return;
          }

          // 拿天气简报
          let w = '天气未获取';
          try {
            const wp = this.bot?.pluginManager?.plugins?.get('weather');
            if (wp) {
              const city = CITY();
              w = typeof wp.getBriefByCity === 'function'
                ? await wp.getBriefByCity(city)
                : await wp.getBrief(city);
            }
          } catch {}

          let text;
          try {
            text = await chat(t.p(w), { history: [], summary: '', time: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) });
          } catch (e) {
            console.error(`[Schedule] ${t.id} LLM 失败，用降级文案:`, e.message);
            text = FALLBACK[t.id];
          }

          try {
            const { push } = require('../core/push');
            await push(text);
            console.log(`[Schedule] ✅ ${t.id} 任务触发 @ ${hm}`);
          } catch (e) { console.error(`[Schedule] ${t.id} 推送失败:`, e.message); }
        })().catch(e => console.error(`[Schedule] ${t.id} 异常:`, e.message));
      }
    }, 20_000);
    this._timer.unref?.();
  }
}

module.exports = SchedulePlugin;
