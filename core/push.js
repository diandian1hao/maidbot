// core/push.js - 主动推送通道（早安/晚安/定时播报）
// 自包含：自动读取 .env / config.json 凭证，不依赖项目其他模块
const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const ENV_FILE   = path.join(ROOT, '.env');
const OWNER_FILE = path.join(ROOT, '.owner.json');

// ---------- 加载 .env（有 dotenv 用 dotenv，没有就手动解析）----------
(function loadEnv() {
  try { require('dotenv').config({ path: ENV_FILE }); } catch {}
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined)
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
})();

// ---------- 凭证：兼容多种命名 + config.json 兜底 ----------
function getCreds() {
  const e = process.env;
  let id     = e.APP_ID || e.APPID || e.QQ_APP_ID || e.BOT_APPID;
  let secret = e.APP_SECRET || e.APPSECRET || e.CLIENT_SECRET || e.APP_SECRET_TOKEN || e.QQ_APP_SECRET;
  if (!id || !secret) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
      id     = id     || c.appId || c.APP_ID || c.app_id;
      secret = secret || c.appSecret || c.APP_SECRET || c.clientSecret || c.secret;
    } catch {}
  }
  return { id, secret };
}

// ---------- access_token（自动缓存）----------
let _token = null, _exp = 0;
async function getToken() {
  if (_token && Date.now() < _exp - 60_000) return _token;
  const { id, secret } = getCreds();
  if (!id || !secret) throw new Error('找不到 appId/appSecret（检查 .env 或 config.json）');
  const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: String(id), clientSecret: String(secret) }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('获取 token 失败: ' + JSON.stringify(j));
  _token = j.access_token;
  _exp   = Date.now() + (Number(j.expires_in) || 7200) * 1000;
  return _token;
}

// ---------- 主人 openid：.owner.json 优先，.env OWNER_OPENID 兜底 ----------
function getOwner() {
  try {
    const f = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    if (f.openid) return f.openid;
  } catch {}
  return process.env.OWNER_OPENID || null;
}

// 记住主人（index.js 收到私聊时自动调用）
function rememberOwner(openid) {
  if (!openid) return false;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')); } catch {}
  if (data.openid === openid) return false;
  data.openid = openid;
  data.since  = new Date().toISOString();
  fs.writeFileSync(OWNER_FILE, JSON.stringify(data, null, 2));
  console.log('[Push] 🎀 已记住主人 openid:', openid);
  return true;
}

// ---------- 主动推送 ----------
async function push(text) {
  const owner = getOwner();
  if (!owner) {
    console.log('[Push] 无主人 openid，本条丢弃（请先在 QQ 给 Bot 发一句话，或在 .env 设置 OWNER_OPENID）');
    return false;
  }
  const token = await getToken();
  const r = await fetch(`https://api.sgroup.qq.com/v2/users/${owner}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, msg_type: 0 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`推送失败 HTTP ${r.status}: ` + JSON.stringify(j));
  console.log('[Push] ✅ 已主动推送给主人:', String(text).slice(0, 40));
  return true;
}

// ---------- 主动推送给指定用户（视觉异步回调用） ----------
async function pushTo(openid, text) {
  if (!openid) throw new Error("pushTo: 缺少 openid");
  const token = await getToken();
  const r = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: "POST",
    headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: String(text), msg_type: 0 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`pushTo 失败 HTTP ${r.status}: ` + JSON.stringify(j));
  console.log("[Push] ✅ 已主动推送给用户", String(openid).slice(0, 12), ":", String(text).slice(0, 40));
  return true;
}

module.exports = { push, pushTo, rememberOwner, getOwner };
