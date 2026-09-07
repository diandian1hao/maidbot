// 单例桥接：push.js / weather.js 用 require('./apiSingleton') 即可直接调 sendC2C
// 从 .env 读凭证懒加载实例，避免循环依赖
const ApiClient = require('./api');
let instance = null;
function get() {
  if (!instance) {
    const appId = process.env.APP_ID;
    const appSecret = process.env.APP_SECRET;
    if (!appId || !appSecret) throw new Error('[apiSingleton] 缺少 APP_ID / APP_SECRET');
    instance = new ApiClient(appId, appSecret);
  }
  return instance;
}
module.exports = {
  sendC2C: (openid, text) => get().sendC2C(openid, text),
  replyC2C: (...args) => get().replyC2C(...args),
};
