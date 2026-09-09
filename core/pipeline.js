// core/pipeline.js —— 双端共享消息管道注册中心
// index.js 启动时 register 处理函数；web 插件等任意端通过 chat() 复用同一条插件责任链
let handler = null;

module.exports = {
  register(fn) {
    if (typeof fn !== 'function') throw new Error('pipeline.register 需要函数');
    handler = fn;
  },
  isReady() {
    return typeof handler === 'function';
  },
  async chat(userId, text, opts = {}) {
    if (typeof handler !== 'function') throw new Error('pipeline 未就绪');
    return handler(userId, text, opts);
  },
};
