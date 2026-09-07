// MaidBot.js

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Database = require('better-sqlite3');

class MaidBot {
    constructor() {
        // 1. 初始化配置与客户端
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl || 'https://api.deepseek.com',
        });
        this.modelName = config.modelName || 'deepseek-chat';

        // 2. 初始化数据库
        this.db = new Database('chat_memory.db');
        
        // 核心建表语句
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 🛡️ 防御性代码：检查旧表是否缺少 user_id 字段
        // 如果缺少，自动添加，防止 "no such column" 报错
        const columns = this.db.prepare("PRAGMA table_info(messages)").all();
        const hasUserId = columns.some(col => col.name === 'user_id');
        if (!hasUserId) {
            console.log("⚙️ 检测到旧版数据库，正在自动升级表结构...");
            this.db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT NOT NULL DEFAULT 'unknown'");
        }

        // 3. 加载系统人格 (只加载一次)
        this.systemPrompt = this._loadPersonality();

        // 4. 内存缓存：用于存储每个用户的实时对话上下文
        // 格式: { 'user_A': [...messages], 'user_B': [...messages] }
        this.userSessions = {};

        // 5. 工具定义 (为未来扩展预留)
        this.tools = [
            {
                type: "function",
                function: {
                    name: "get_current_time",
                    description: "获取当前的日期和具体时间",
                    parameters: { type: "object", properties: {}, required: [] }
                }
            }
        ];
    }

    // 私有方法：加载人格
    _loadPersonality() {
        const possiblePaths = [
            path.join(__dirname, 'prompts', 'maid.txt'),
            path.join(__dirname, 'maid.txt')
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                return fs.readFileSync(p, 'utf-8').trim();
            }
        }
        return "你是一个乐于助人的AI助手。";
    }

    // 私有方法：获取或初始化用户的会话
    _getSession(userId) {
        if (!this.userSessions[userId]) {
            // 如果内存中没有，从数据库加载最近10条记录
            const rows = this.db.prepare(
                'SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 10'
            ).all(userId);
            
            const history = rows.reverse().map(row => ({ role: row.role, content: row.content }));
            this.userSessions[userId] = [
                { role: "system", content: this.systemPrompt },
                ...history
            ];
        }
        return this.userSessions[userId];
    }

    // 私有方法：获取当前时间
    _getCurrentTime() {
        const now = new Date();
        return now.toLocaleString('zh-CN', { hour12: false });
    }

    // 核心对外接口：处理用户消息
    async chat(userId, userInput) {
        const messages = this._getSession(userId);
        
        // 1. 用户消息入列
        messages.push({ role: "user", content: userInput });
        this.db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'user', userInput);

        try {
            // 2. 第一次请求 API
            const response1 = await this.client.chat.completions.create({
                model: this.modelName,
                messages: messages,
                tools: this.tools,
                tool_choice: "auto"
            });

            const message1 = response1.choices[0].message;

            // 3. 处理工具调用
            if (message1.tool_calls) {
                messages.push(message1);
                for (const toolCall of message1.tool_calls) {
                    if (toolCall.function.name === "get_current_time") {
                        const timeResult = this._getCurrentTime();
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: timeResult
                        });
                    }
                }

                // 4. 第二次请求 API
                const response2 = await this.client.chat.completions.create({
                    model: this.modelName,
                    messages: messages
                });
                
                const reply = response2.choices[0].message.content;
                messages.push({ role: "assistant", content: reply });
                this.db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'assistant', reply);
                return reply;

            } else {
                // 5. 普通对话
                const reply = message1.content;
                messages.push({ role: "assistant", content: reply });
                this.db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'assistant', reply);
                return reply;
            }

        } catch (error) {
            console.error(` 用户 ${userId} 对话出错:`, error.message);
            messages.pop(); // 移除失败的用户消息
            return "女仆: 哼，刚才脑子有点短路了，笨蛋主人再说一遍吧！";
        }
    }

    // 清空指定用户的记忆
    clearMemory(userId) {
        this.db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
        this.userSessions[userId] = [{ role: "system", content: this.systemPrompt }];
    }
}

// 导出类，供外部使用
module.exports = MaidBot;