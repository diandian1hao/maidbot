const path = require('path');
const express = require('express');
const repo = require('../core/memoryRepository');
const llm = require('../llm');
const logger = require('../utils/logger');
const pipeline = require('../core/pipeline');   // 🆕 复用主控插件责任链

// ====== 应用层流控：个人 10 次/天 + 全站 100 次/天 ======
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
  if (getRecord(req.ip).count >= DAILY_LIMIT) {
    return res.status(429).json({ error: '今日个人额度已耗尽（10 次/天）', remaining: 0 });
  }
  if (getGlobalRecord().count >= GLOBAL_DAILY_LIMIT) {
    return res.status(429).json({ error: '今日全站额度已耗尽（100 次/天）', remaining: 0, global: true });
  }
  next();
};

// ====== 内嵌 HTML（原生 JS，零外部 CDN 依赖）======
const buildHTML = (remaining) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MaidBot Web</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#111827;color:#f3f4f6;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;height:100vh;display:flex;flex-direction:column;align-items:center}
.wrap{width:100%;max-width:768px;height:100%;display:flex;flex-direction:column;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #374151;margin-bottom:16px}
h1{font-size:20px;color:#4ade80}
.badge{background:#1f2937;border:1px solid #4b5563;border-radius:999px;padding:4px 12px;font-size:13px}
.badge b{font-family:ui-monospace,Consolas,monospace;color:#60a5fa}
.badge b.zero{color:#f87171}
#chat-box{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding-right:6px;scrollbar-width:none}
#chat-box::-webkit-scrollbar{display:none}
.row{display:flex;gap:10px}
.row.user{flex-direction:row-reverse}
.avatar{width:32px;height:32px;border-radius:50%;background:#16a34a;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
.row.user .avatar{background:#2563eb}
.bubble{background:#1f2937;padding:10px 14px;border-radius:16px;border-top-left-radius:4px;max-width:80%;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.row.user .bubble{background:#1e3a8a;border-radius:16px;border-top-right-radius:4px}
.meta{font-size:11px;color:#6b7280;margin:-8px 0 0 42px}
.inputbar{margin-top:14px;display:flex;gap:8px}
#input{flex:1;background:#1f2937;border:1px solid #374151;border-radius:10px;padding:12px 14px;color:#e5e7eb;font-size:14px;outline:none}
#input:focus{border-color:#22c55e}
#input:disabled,#send:disabled{opacity:.5;cursor:not-allowed}
#send{background:#16a34a;color:#fff;border:none;border-radius:10px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer}
#send:hover:not(:disabled){background:#15803d}
footer{font-size:12px;color:#6b7280;margin-top:8px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🤖 MaidBot Web</h1>
    <div class="badge">剩余: <b id="remaining">-</b>/10</div>
  </header>
  <div id="chat-box">
    <div class="row"><div class="avatar">AI</div><div class="bubble">你好！我是 MaidBot，每日限制 10 条对话。</div></div>
  </div>
  <div class="inputbar">
    <input id="input" type="text" placeholder="输入消息..." autocomplete="off">
    <button id="send">发送</button>
  </div>
  <footer id="foot">MaidBot Plugin Architecture | Daily Limit Enabled</footer>
</div>
<script>
(function(){
  var remaining = ${remaining};
  var isSending = false;
  var box = document.getElementById('chat-box');
  var input = document.getElementById('input');
  var btn = document.getElementById('send');
  var remEl = document.getElementById('remaining');
  var foot = document.getElementById('foot');
  function scroll(){ box.scrollTop = box.scrollHeight; }
  function refreshFooter(){
    fetch('/api/status').then(function(r){ return r.json(); }).then(function(d){
      if (typeof d.remaining === 'number') { remaining = d.remaining; remEl.textContent = remaining; remEl.className = (remaining > 0 ? '' : 'zero'); }
      if (typeof d.globalRemaining === 'number') {
        foot.textContent = 'MaidBot Plugin Architecture | 个人 10 次/天 · 全站剩余 ' + d.globalRemaining + '/100';
      }
      var dis = isSending || remaining <= 0;
      input.disabled = dis; btn.disabled = dis || !input.value.trim();
    }).catch(function(){});
  }
  function refresh(){
    remEl.textContent = remaining;
    remEl.className = (remaining > 0 ? '' : 'zero');
    var dis = isSending || remaining <= 0;
    input.disabled = dis;
    btn.disabled = dis || !input.value.trim();
  }
  function addRow(role, text){
    var row = document.createElement('div'); row.className = 'row' + (role === 'user' ? ' user' : '');
    var av = document.createElement('div'); av.className = 'avatar'; av.textContent = (role === 'user' ? '我' : 'AI');
    var b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
    row.appendChild(av); row.appendChild(b); box.appendChild(row); scroll();
    return b;
  }
  function addMeta(text){
    var m = document.createElement('div'); m.className = 'meta'; m.textContent = text;
    box.appendChild(m); scroll();
  }
  async function send(){
    var t = input.value.trim();
    if (!t || isSending || remaining <= 0) return;
    addRow('user', t); input.value = ''; isSending = true; btn.textContent = '发送中...'; refresh();
    var bubble = addRow('ai', '');
    var pluginName = null;
    try {
      var r = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: t }) });
      if (r.status === 429) {
        var d429 = await r.json().catch(function(){ return {}; });
        remaining = 0; refresh();
        bubble.textContent = '🚫 ' + (d429.error || '今日额度已耗尽');
        refreshFooter();
        return;
      }
      if (!r.ok || !r.body) { bubble.textContent = '❌ 服务器错误 (' + r.status + ')'; return; }
      var reader = r.body.getReader(); var dec = new TextDecoder('utf-8'); var buf = '';
      while (true) {
        var chunk = await reader.read(); if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        var events = buf.split('\\n\\n'); buf = events.pop() || '';
        for (var i = 0; i < events.length; i++) {
          var lines = events[i].split('\\n');
          for (var j = 0; j < lines.length; j++) {
            if (lines[j].indexOf('data: ') !== 0) continue;
            var payload = lines[j].slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              var p = JSON.parse(payload);
              if (p.text) { bubble.textContent += p.text; scroll(); }
              if (p.meta) { pluginName = String(p.meta).replace(/^plugin:/, ''); }
              if (p.error) { bubble.textContent += '\\n⚠️ ' + p.error; }
            } catch (e) {}
          }
        }
      }
      if (!bubble.textContent) bubble.textContent = '（没有插件或模型响应）';
      if (pluginName) addMeta('⚙️ 由插件「' + pluginName + '」响应');
      remaining = Math.max(0, remaining - 1);
    } catch (e) {
      bubble.textContent = '❌ 网络错误: ' + (e && e.message ? e.message : e);
    } finally {
      isSending = false; btn.textContent = '发送'; refresh(); input.focus();
      refreshFooter();  // ✅ 每次发送后重新拉取最新余量（含全站）
    }
  }
  btn.addEventListener('click', send);
  input.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
  input.addEventListener('input', refresh);
  refreshFooter(); // 页面加载时拉取初始值
})();
</script>
</body></html>`;

class WebServerPlugin {
  constructor(bot) {
    this.bot = bot;
    this.name = 'web-client';
    this.priority = 999;
    console.log('[Web-Plugin] 🔧 构造函数已执行，正在启动 Express...');
    try {
      this._startServer();
    } catch (err) {
      console.error('[Web-Plugin] ❌ _startServer 异常:', err.message);
      console.error(err.stack);
    }
  }

  _startServer() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());

    app.get('/api/status', (req, res) => {
      res.json({ remaining: getRemaining(req.ip), globalRemaining: getGlobalRemaining() });
    });

    app.options('/api/chat', (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.sendStatus(204);
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
        if (!reply) {
          write('（没有插件或模型响应）');
        } else {
          for (const ch of String(reply).split('')) {
            write(ch);
            await new Promise(r => setTimeout(r, 20));
          }
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
      res.send(buildHTML(getRemaining(req.ip)));
    });

    const PORT = process.env.WEB_PORT || 3001;
    app.listen(PORT, () => {
      logger.info(`[Web-Plugin] 🌐 Web Client 已启动: http://localhost:${PORT}`);
      logger.info(`[Web-Plugin] 🛡️ 限流: 个人 ${DAILY_LIMIT} 次/天, 全站 ${GLOBAL_DAILY_LIMIT} 次/天`);
    });
  }

  async handleMessage(msgData, bot) {
    return null;
  }
}

module.exports = WebServerPlugin;
