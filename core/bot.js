// core/bot.js (QQ + Feishu 双端兼容版 - 飞书 WSS v2 直连模式)
const WebSocket = require('ws');
const { ApiClient } = require('./api');
const health = require('./health');
const logger = require('../utils/logger');

let lark;
try { lark = require('@larksuiteoapi/node-sdk'); } catch (e) {}

const INTENTS = (1 << 25);

class MaidBot {
  constructor(config) {
    if (!config?.appId || !config?.appSecret) {
      throw new Error('config 中缺少 appId 或 appSecret!');
    }
    this.appId = String(config.appId).trim();
    this.appSecret = String(config.appSecret).trim();
    this.onEvent = config.onEvent || (() => {});
    this.platform = this.appId.startsWith('cli_') ? 'feishu' : 'qq';

    this.ws = null; this.seq = null; this.sessionId = null;
    this.heartbeatTimer = null; this.heartbeatAcked = true;
    this.reconnectDelay = 1000; this.authFails = 0; this.stopped = false;

    if (this.platform === 'qq') {
      this.api = new ApiClient(this.appId, this.appSecret);
    } else {
      this.feishuClient = lark ? new lark.Client({
        appId: this.appId, appSecret: this.appSecret,
        encryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "", loggerLevel: lark.LoggerLevel.debug
      }) : null;

      this.api = {
        replyC2C: async (_userId, msgId, text) => {
          if (!this.feishuClient) throw new Error('飞书 SDK 未安装');
          await this.feishuClient.im.message.reply({
            path: { message_id: msgId },
            data: { content: JSON.stringify({ text }), msg_type: 'text' }
          });
        },
        getToken: async () => 'feishu_token_placeholder'
      };
    }
  }

  async start() {
    logger.info(`[Bot] 正在启动核心流程... (Platform: ${this.platform})`);
    if (this.platform === 'feishu') await this._startFeishu();
    else await this._startQQ();
  }

  // ====== 飞书 WSS v2 直连模式 ======
  async _startFeishu() {
    if (!lark) { logger.error('[Bot] ❌ 飞书 SDK 未安装'); return; }

    const sdkVersion = require('@larksuiteoapi/node-sdk/package.json').version;
    logger.info(`[Bot] 飞书 SDK 版本: ${sdkVersion} (WSS v2 官方 WSClient + EventDispatcher 模式)`);

    try {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            health.messageReceived();
            const msg = data.message || {};
            const sender = data.sender || {};

            let text = '';
            try {
              const c = JSON.parse(msg.content || '{}');
              text = (c.text || '').replace(/@_user_\d+/g, '').trim();
            } catch { text = msg.content || ''; }

            const senderId = sender.sender_id || {};
            const unifiedEvent = {
              author: {
                user_openid: senderId.open_id || senderId.user_id || 'unknown',
                id: senderId.user_id || 'unknown',
              },
              content: text,
              id: msg.message_id,
              group_openid: msg.chat_type === 'group' ? msg.chat_id : undefined,
              channel_id: msg.chat_id,
            };

            const mappedType = msg.chat_type === 'p2p' ? 'C2C_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE';
            logger.info(`[Feishu] 📨 type=${mappedType} user=${unifiedEvent.author.user_openid} text="${text.slice(0, 30)}"`);
            this.onEvent(mappedType, unifiedEvent);
          } catch (e) {
            logger.error(`[Feishu] 事件解析失败: ${e.message}`);
          }
        },
      });

      const wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: lark.LoggerLevel.debug,

      });

      await wsClient.start({ eventDispatcher });
      health.setWs(true);
      logger.info('[Bot] ✅ 飞书 WSS v2 已通过官方 WSClient + EventDispatcher 启动');

    } catch (e) {
      logger.error(`[Bot] ❌ 飞书启动失败: ${e.message}`);
      if (e.stack) logger.error(`[Bot] Stack: ${e.stack.split('\n').slice(0, 3).join('\n')}`);
      health.setWs(false);
      if (!this.stopped) {
        setTimeout(() => this._startFeishu(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }
    }
  }
  async _startQQ() {
    try {
      const token = await this.api.getToken();
      const res = await fetch('https://api.sgroup.qq.com/gateway',
        { headers: { Authorization: `QQBot ${token}` } });
      const { url } = await res.json();
      logger.info(`[Bot] 连接网关: ${url}`);
      this.ws = new WebSocket(url || 'wss://api.sgroup.qq.com/websocket');
    } catch (e) {
      logger.error(`[Bot] 连接准备失败: ${e.message}，5s 后重试`);
      return setTimeout(() => this._startQQ(), 5000);
    }
    this.ws.on('open', () => { logger.info('[Bot] QQ WS 已建立'); health.setWs(true); });
    this.ws.on('message', raw => this._onQQMessage(raw));
    this.ws.on('close', (code, r) => this._onQQClose(code, r.toString()));
    this.ws.on('error', e => { logger.error(`[Bot] QQ WS 错误: ${e.message}`); health.setWs(false); });
  }

  _onQQMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { op, d, s, t } = msg;
    if (s) this.seq = s;
    switch (op) {
      case 10:
        logger.info(`[Bot] Hello, heartbeat: ${d.heartbeat_interval}`);
        this._startHeartbeat(d.heartbeat_interval); this._identify(); break;
      case 11: this.heartbeatAcked = true; health.heartbeat(); break;
      case 0:
        if (t === 'READY') {
          this.sessionId = d.session_id; this.authFails = 0; this.reconnectDelay = 1000;
          logger.info(`[Bot] QQ READY session: ${this.sessionId}`);
        }
        this.onEvent(t, d); break;
      case 7: logger.info('[Bot] 服务器要求重连'); this.ws?.close(); break;
      case 9: logger.warn('[Bot] 无效会话'); this.seq = null; setTimeout(() => this._identify(), 3000); break;
    }
  }

  async _identify() {
    const token = await this.api.identifyToken();
    this._send({ op: 2, d: { token, intents: INTENTS, shard: [0, 1],
      properties: { $os: 'linux', $browser: 'maidbot', $device: 'maidbot' } }});
  }

  _startHeartbeat(interval) {
    this._stopHeartbeat(); this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) { this._stopHeartbeat(); return this.ws?.terminate(); }
      this.heartbeatAcked = false; this._send({ op: 1, d: this.seq });
    }, interval);
  }
  _stopHeartbeat() { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  _send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  async _onQQClose(code, reason) {
    health.setWs(false); this._stopHeartbeat();
    if (this.stopped) return;
    if (code === 4004) {
      if (++this.authFails > 3) return logger.error('[Bot] 连续 4004');
      await this.api.refreshToken().catch(e => logger.error(`[API] 刷新失败: ${e.message}`));
    } else if (code !== 4009) {
      await new Promise(r => setTimeout(r, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    }
    this.seq = null; this._startQQ();
  }

  stop() {
    this.stopped = true;
    this._stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }
}

module.exports = { MaidBot };
