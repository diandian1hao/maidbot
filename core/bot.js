// core/bot.js
const WebSocket = require('ws');
const { ApiClient } = require('./api');
const health = require('./health'); // ⭐ P1.5: 健康探针
const logger = require('../utils/logger');

// 群/@ + C2C 私聊 + 公共频道
const INTENTS = (1 << 25);

class MaidBot {
  constructor(config) {
    if (!config?.appId || !config?.appSecret) {
      throw new Error('config 中缺少 appId 或 appSecret! 请检查 index.js 或 .env');
    }
    this.api = new ApiClient(config.appId, config.appSecret);
    this.onEvent = config.onEvent || (() => {});
    this.ws = null; this.seq = null; this.sessionId = null;
    this.heartbeatTimer = null; this.heartbeatAcked = true;
    this.reconnectDelay = 1000; this.authFails = 0; this.stopped = false;
  }

  async start() { logger.info('[Bot] 正在启动核心流程...'); await this.connect(); }

  async connect() {
    try {
      const token = await this.api.getToken();
      const res = await fetch('https://api.sgroup.qq.com/gateway',
        { headers: { Authorization: `QQBot ${token}` } });
      const { url } = await res.json();
      logger.info(`[Bot] 连接网关: ${url}`);
      this.ws = new WebSocket(url || 'wss://api.sgroup.qq.com/websocket');
    } catch (e) {
      logger.error(`[Bot] 连接准备失败: ${e.message}，5 秒后重试`);
      return setTimeout(() => this.connect(), 5000);
    }
    this.ws.on('open',    () => { logger.info('[Bot] WebSocket 物理连接已建立'); health.setWs(true); });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('close',   (code, r) => this.onClose(code, r.toString()));
    this.ws.on('error',   e  => { logger.error(`[Bot] WS 错误: ${e.message}`); health.setWs(false); });
  }

  onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { op, d, s, t } = msg;
    if (s) this.seq = s;

    switch (op) {
      case 10:
        logger.info(`[Bot] 收到 Hello，心跳间隔: ${d.heartbeat_interval}`);
        this.startHeartbeat(d.heartbeat_interval);
        this.identify();
        break;
      case 11: this.heartbeatAcked = true; health.heartbeat(); break; // ⭐ P1.5
      case 0:
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.authFails = 0; this.reconnectDelay = 1000;
          logger.info(`[Bot] 登录成功 (READY)，session: ${this.sessionId}`);
        }
        this.onEvent(t, d);
        break;
      case 7: logger.info('[Bot] 服务器要求重连'); this.ws?.close(); break;
      case 9: logger.warn('[Bot] 无效会话，3 秒后重新鉴权');
        this.seq = null; setTimeout(() => this.identify(), 3000); break;
    }
  }

  async identify() {
    const token = await this.api.identifyToken();
    logger.info(`[Auth] 发送 Identify (AppID: ${this.api.appId})`);
    this.send({ op: 2, d: {
      token, intents: INTENTS, shard: [0, 1],
      properties: { $os: 'linux', $browser: 'maidbot', $device: 'maidbot' },
    }});
  }

  startHeartbeat(interval) {
    this.stopHeartbeat();
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        logger.warn('[Bot] 心跳 ACK 超时，判定连接已死，强制重连');
        this.stopHeartbeat();
        return this.ws?.terminate();
      }
      this.heartbeatAcked = false;
      this.send({ op: 1, d: this.seq });
    }, interval);
  }
  stopHeartbeat() { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  async onClose(code, reason) {
    health.setWs(false); // ⭐ P1.5: 标记 WS 断开
    this.stopHeartbeat();
    logger.warn(`[Bot] 连接断开 Code: ${code}, Reason: ${reason}`);
    if (this.stopped) return;

    if (code === 4004) {
      if (++this.authFails > 3) {
        return logger.error('[Bot] 连续 4004，检查凭证/格式，停止重连');
      }
      await this.api.refreshToken().catch(e => logger.error(`[API] 刷新失败: ${e.message}`));
    } else if (code !== 4009) {
      await new Promise(r => setTimeout(r, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    }
    logger.info('[Bot] Reconnecting...');
    this.seq = null;
    this.connect();
  }

  stop() { this.stopped = true; this.ws?.close(); }
}

module.exports = { MaidBot };
