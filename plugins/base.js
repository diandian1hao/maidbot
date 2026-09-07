class BasePlugin {
    constructor() {
        this.name = 'base';
    }

    // 处理收到的消息
    async handleMessage(msgData, botInstance) {
        const { content, sender_id } = msgData;
        console.log(`[Base] 收到消息: ${content} from ${sender_id}`);
        
        // 这里可以做一些基础过滤，比如屏蔽词
        if (content.includes('笨蛋')) {
            return "你说谁笨蛋呢！无礼之徒！";
        }
        
        return null; // 返回 null 表示交给下一个插件（比如AI）处理
    }
}

module.exports = BasePlugin;
