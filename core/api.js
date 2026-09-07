// core/api.js
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

class ApiClient {
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.API_BASE = 'https://api.sgroup.qq.com';
    this._token = null;
    this._expiresAt = 0;
    this._refreshing = null;
    this._timer = null;
    this._lastRefreshAt = 0; // ⭐ P0: 上次成功刷新时间戳(防连转)
  }

  /** 取可用 token：距过期不足 5 分钟则自动刷新 */
  async getToken() {
    const now = Date.now();
    if (this._token && now < this._expiresAt - 5 * 60_000) return this._token;
    // ⭐ P0 防连转: token 仍有效且 60s 内刚刷过 → 直接复用, 避免短命 token 刷新风暴
    if (this._token && now < this._expiresAt && now - this._lastRefreshAt < 60_000) return this._token;
    return this.refreshToken();
  }

  /** 强制刷新（Promise 去重，防止并发重复请求） */
  refreshToken() {
    if (!this._refreshing) {
      this._refreshing = this._fetch().finally(() => (this._refreshing = null));
    }
    return this._refreshing;
  }

  async _fetch() {
    console.log('[API] 刷新 Token... AppID:', this.appId);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Token 获取失败: ' + JSON.stringify(data));

    this._token = data.access_token;
    const ttl = (parseInt(data.expires_in, 10) || 7200) * 1000;
    this._expiresAt = Date.now() + ttl;
    this._lastRefreshAt = Date.now(); // ⭐ P0

    // ⭐ 2 小时轮换的关键：过期前 5 分钟主动刷新，永不让缓存 token 过期
    // ⭐ P0 修复: 网关偶发短命 token(<5min) 时 ttl-5min 为负数, setTimeout 负延迟=立即触发 → 递归风暴
    let delay = ttl - 5 * 60_000;
    if (delay < 30_000) delay = Math.max(Math.floor(ttl / 2), 10_000);
    if (ttl < 5 * 60_000) console.warn('[API] ⚠️ 短命 token ' + Math.round(ttl/1000) + 's, 下次刷新 ' + Math.round(delay/1000) + 's 后');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.refreshToken().catch(e => console.error('[API] ⚠️ 主动刷新失败:', e.message));
    }, delay);
    this._timer.unref?.();

    console.log(`[API] ✅ Token 刷新成功，有效期 ${Math.round(ttl / 60000)} 分钟，已预约下次刷新`);
    try { require('./health').setTokenExpiry(this._expiresAt); } catch (e) {} // ⭐ P1.5: 同步 token 过期时间到探针
    return this._token;
  }

  /** WebSocket Identify 凭证（官方格式） */
  async identifyToken() { return `QQBot ${await this.getToken()}`; }
  /** HTTP 接口 Authorization 头 */
  async authHeader()     { return `QQBot ${await this.getToken()}`; }

  /** ⭐ 回复 C2C 私聊（v2 接口，必须带 msg_id 做被动回复凭证） */
  async replyC2C(userOpenid, msgId, content, msgSeq = 1) {
    const url = `${this.API_BASE}/v2/users/${userOpenid}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': await this.authHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, msg_id: msgId, msg_seq: msgSeq }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[API] ❌ 回复失败:', res.status, JSON.stringify(data));
        return null;
      }
      console.log('[API] ✅ 已回复:', String(content).slice(0, 20));
      return data;
    } catch (e) {
      console.error('[API] ❌ 回复异常:', e.message);
      return null;
    }
  }
}

module.exports = { ApiClient };
