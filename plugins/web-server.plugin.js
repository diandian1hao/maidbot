const path = require('path');
const express = require('express');
const repo = require('../core/memoryRepository');
const llm = require('../llm');
const logger = require('../utils/logger');
const pipeline = require('../core/pipeline');
const metrics = require('../metrics');
const { devChat } = require('../core/devPipeline');
const dm = require('../core/devMemory');

const DEV_USER_ID = '0E612530550ECF682BC85A53FA8C12D3';

// ====== 应用层流控 ======
const rateLimitMap = new Map();
const DAILY_LIMIT = 10;
const GLOBAL_DAILY_LIMIT = 100;
const MS_IN_DAY = 24 * 60 * 60 * 1000;

const getRecord = (ip) => {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, { count: 0, startTime: now });
  const record = rateLimitMap.get(ip);
  if (now - record.startTime > MS_IN_DAY) { record.count = 0; record.startTime = now; }
  return record;
};
const getRemaining = (ip) => Math.max(0, DAILY_LIMIT - getRecord(ip).count);

let globalRecord = { count: 0, startTime: Date.now() };
const getGlobalRecord = () => {
  const now = Date.now();
  if (now - globalRecord.startTime > MS_IN_DAY) globalRecord = { count: 0, startTime: now };
  return globalRecord;
};
const getGlobalRemaining = () => Math.max(0, GLOBAL_DAILY_LIMIT - getGlobalRecord().count);

const dailyRateLimiter = (req, res, next) => {
  if (getRecord(req.ip).count >= DAILY_LIMIT) return res.status(429).json({ error: '今日个人额度已耗尽（10 次/天）', remaining: 0 });
  if (getGlobalRecord().count >= GLOBAL_DAILY_LIMIT) return res.status(429).json({ error: '今日全站额度已耗尽（100 次/天）', remaining: 0, global: true });
  next();
};

class WebServerPlugin {
  constructor(bot) {
    this.bot = bot;
    this.name = 'web-client';
    this.priority = 999;
    try { this._startServer(); } catch (err) { console.error(err); }
  }

  _startServer() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());

    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath));
    app.use('/dev-files', express.static(path.join(__dirname, '../logs/dev-output')));
    app.get('/dev', (req, res) => res.redirect('/dev.html'));
    app.get('/favicon.ico', (req, res) => res.status(204).end());

    app.get('/api/status', (req, res) => {
      res.json({ remaining: getRemaining(req.ip), globalRemaining: getGlobalRemaining() });
    });

    app.post('/api/chat', dailyRateLimiter, async (req, res) => {
      const { message } = req.body || {};
      if (!message) return res.status(400).json({ error: '消息不能为空' });
      const ip = req.ip;
      getRecord(ip).count++;
      getGlobalRecord().count++;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const write = (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`);
      const userId = 'web_' + String(ip).replace(/[^a-zA-Z0-9]/g, '_');
      metrics.msg('C2C');
      metrics.users(rateLimitMap.size);
      const reqStart = Date.now();
      try {
        let reply = null;
        let pluginName = null;
        if (pipeline.isReady()) {
          const result = await pipeline.chat(userId, String(message), { source: 'web' });
          reply = result && result.reply ? result.reply : null;
          pluginName = result && result.plugin ? result.plugin : null;
        } else {
          const memories = await repo.search(userId, String(message), { topK: 3 }).catch(() => []);
          reply = await llm.chat(String(message), memories);
        }
        metrics.searchTotal.inc({ status: 'ok' });
        metrics.latency('main', 'ok', (Date.now() - reqStart) / 1000);
        if (!reply) { write('（没有插件或模型响应）'); } else {
          for (const ch of String(reply).split('')) { write(ch); await new Promise(r => setTimeout(r, 20)); }
        }
        if (pluginName) res.write(`data: ${JSON.stringify({ meta: 'plugin:' + pluginName })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        logger.error(`[Web-Plugin] 对话异常: ${error.message}`);
        res.write(`data: ${JSON.stringify({ error: '内部异常' })}\n\n`);
        res.end();
      }
    });

    app.get('/', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.send(`<!DOCTYPE html><html><body><h2>MaidBot Web 运行中</h2><p>请访问 <a href="/dev.html">/dev.html</a> 进入控制台</p></body></html>`);
    });

    app.get('/api/dev/projects', (req, res) => {
      try {
        const projects = dm.listUserProjects(DEV_USER_ID);
        res.json({ success: true, projects });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.delete('/api/dev/projects/:group/:project', (req, res) => {
      try {
        dm.deleteProject(DEV_USER_ID, req.params.group, req.params.project);
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.delete('/api/dev/groups/:group', (req, res) => {
      try {
        dm.deleteGroup(DEV_USER_ID, req.params.group);
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.post('/api/dev/projects/move', (req, res) => {
      const { oldGroup, project, newGroup } = req.body;
      try {
        dm.moveProjectToGroup(DEV_USER_ID, oldGroup, project, newGroup);
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.post('/api/dev/chat', async (req, res) => {
      const { query } = req.body;
      if (!query) return res.status(400).json({ success: false, error: '缺少 query' });

      try {
        let finalQuery = query.trim();

        if (finalQuery === '/dev status' || finalQuery === 'status') {
          const active = dm.getActiveSession(DEV_USER_ID);
          if (!active) return res.json({ success: false, error: '请先锁定项目组' });
          const stats = dm.stats();
          const reply = `📊 **当前系统状态**\n\n- 当前锁定: [${active.group_name}] ${active.project_name}\n- 黑板代码量: ${active.last_code ? active.last_code.length : 0} 字符\n- 全局 L1 经验库: ${stats.experience} 条\n- 累计蒸馏次数: ${stats.distilled} 次`;
          return res.json({ success: true, reply, provider: 'system', reviewer: 'none', latency: 0 });
        }

        if (finalQuery.startsWith('/dev note ') || finalQuery.startsWith('note ')) {
          const noteContent = finalQuery.replace(/^(\/dev\s+)?note\s+/, '').trim();
          const active = dm.getActiveSession(DEV_USER_ID);
          if (!active) return res.json({ success: false, error: '请先锁定一个项目组' });
          
          dm.writeEvent({
            source: 'manual_note',
            groupName: active.group_name,
            projectName: active.project_name,
            taskType: 'note',
            rawInput: noteContent,
            rawOutput: '手动沉淀的笔记，等待自动蒸馏。',
            outcome: 'success'
          });
          return res.json({ success: true, reply: `✅ 笔记已静默写入 L0 原始库。\n系统将在 30 分钟内自动将其蒸馏为 L1 经验。`, provider: 'system', reviewer: 'none', latency: 0 });
        }

        // 🆕 核心修复：切换后暴力纠正返回的 is_active 状态
        if (finalQuery.startsWith('/dev use ') || finalQuery.startsWith('use ')) {
          const targetProject = finalQuery.replace(/^(\/dev\s+)?use\s+/, '').trim();
          dm.switchProjectWorkspace(DEV_USER_ID, targetProject);
          
          const active = dm.getActiveSession(DEV_USER_ID);
          const realLockName = active ? `${active.group_name}/${active.project_name}` : targetProject;
          const realGroup = active ? active.group_name : 'common';
          const realProj = active ? active.project_name : targetProject;
          
          const projects = dm.listUserProjects(DEV_USER_ID);
          
          // 暴力纠正：绝对保证只有一个 active
          projects.forEach(p => {
             p.is_active = (p.group_name === realGroup && p.project_name === realProj) ? 1 : 0;
          });

          return res.json({ 
            success: true, 
            reply: `✅ 已锁定项目空间: [${realLockName}]`, 
            projects,
            provider: 'system', reviewer: 'none', latency: 0 
          });
        }
        
        if (finalQuery === '/dev done' || finalQuery === 'done') {
          const active = dm.getActiveSession(DEV_USER_ID);
          if (active) {
            dm.markProjectDone(DEV_USER_ID, active.project_name);
            const projects = dm.listUserProjects(DEV_USER_ID);
            return res.json({ success: true, reply: `✅ 项目 [${active.project_name}] 已归档，黑板已清空，经验已送入蒸馏队列。`, projects, provider: 'system', reviewer: 'none', latency: 0 });
          }
          return res.json({ success: true, reply: `当前没有活跃项目。`, provider: 'system', reviewer: 'none', latency: 0 });
        }

        const active = dm.getActiveSession(DEV_USER_ID);
        if (!active) return res.json({ success: false, error: '请先在左侧选择或创建项目组' });

        const projectName = active.project_name;
        const groupName = active.group_name;
        const isIteration = /报错|修改|不对|错误|换个|改成|优化|重写|继续/i.test(finalQuery);
        const contextCode = isIteration ? (active.last_code || '') : '';

        const result = await devChat(finalQuery, { userId: DEV_USER_ID, groupName, projectName, isIteration, contextCode });
        dm.updateSessionCode(DEV_USER_ID, projectName, result.reply);

        res.json({
          success: true,
          reply: result.reply,
          review: result.review,
          provider: result.provider,
          reviewer: result.reviewer,
          latency: result.latency
        });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    const PORT = process.env.WEB_PORT || 3001;
    app.listen(PORT, () => logger.info(`[Web-Plugin] Web Console: http://localhost:${PORT}/dev.html`));
  }
  async handleMessage(msgData, bot) { return null; }
}

module.exports = WebServerPlugin;
