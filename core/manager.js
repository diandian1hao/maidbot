const fs = require('fs');
const path = require('path');

class PluginManager {
  constructor(bot) {
    this.bot = bot;
    this.plugins = new Map(); // 初始化插件存储
    console.log('[PluginManager] 核心管理器已就绪');
  }

  // ✅ 修复点：补上缺失的 getPluginCount 方法
  getPluginCount() {
    return this.plugins.size;
  }

  async loadAll(dir) {
    console.log(`[PluginManager] 正在扫描插件目录: ${dir}`);
    const fullDir = path.resolve(dir);

    if (!fs.existsSync(fullDir)) {
      console.warn(`[PluginManager] ⚠️ 目录不存在，正在创建: ${fullDir}`);
      fs.mkdirSync(fullDir, { recursive: true });
      return;
    }

    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.js'));
    
    for (const file of files) {
      try {
        const filePath = path.join(fullDir, file);
        // 清除缓存以支持热重载
        delete require.cache[require.resolve(filePath)];
        
        const PluginClass = require(filePath);
        // 兼容 default 导出和直接导出
        const TargetClass = PluginClass.default || PluginClass;

        if (typeof TargetClass === 'function') {
          const instance = new TargetClass(this.bot);
          this.plugins.set(file, instance);
          console.log(`[PluginManager] ✅ 加载成功: ${file}`);
        } else {
          console.warn(`[PluginManager] ⚠️ 跳过非类文件: ${file}`);
        }
      } catch (err) {
        console.error(`[PluginManager] ❌ 加载失败 ${file}:`, err.message);
      }
    }
    
    console.log(`[PluginManager] 🚀 共加载 ${this.getPluginCount()} 个插件`);
  }
}

module.exports = PluginManager;
