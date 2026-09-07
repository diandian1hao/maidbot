const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

class VisionPlugin {
    constructor() {
        this.name = 'vision';
    }

    async init() {
        this.logger?.info?.('[Vision] ✅ 图片识别插件已就绪');
    }

    async handleMessage(msgData, botInstance) {
        try {
            return await this._handleImage(msgData);
        } catch (err) {
            console.error(`[Vision] ❌ handleMessage 异常: ${err.message}`);
            return null;
        }
    }

    async _handleImage(msg) {
        // 1. 提取图片URL（兼容多种消息结构）
        const attachments = msg.attachments

            || msg.raw?.attachments
            || msg.raw?.content?.attachments
            || msg.media
            || msg.rich_media;

        if (!attachments || (Array.isArray(attachments) && attachments.length === 0)) {
            return null;
        }

        const imageAttachment = Array.isArray(attachments)
            ? attachments.find(a => a.content_type?.startsWith('image') || a.type === 'image' || a.url || a.download_url)
            : attachments;

        const imageUrl = imageAttachment?.url || imageAttachment?.download_url || imageAttachment?.src || imageAttachment?.href;
        if (!imageUrl) {
            console.warn(`[Vision] ⚠️ 附件无有效URL`);
            return null;
        }

        console.log(`[Vision] 📷 检测到图片: ${imageUrl.substring(0, 80)}...`);

        let localImagePath;
        try {
            // 2. 下载图片到临时文件（用于日志/缓存，可选）
            const response = await fetchFn(imageUrl);
            if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            localImagePath = path.join(os.tmpdir(), `maidbot_img_${Date.now()}.jpg`);
            await fs.writeFile(localImagePath, buffer);
            console.log(`[Vision] 💾 已保存 ${buffer.length} bytes`);

            // 3. 调用 DeepSeek Vision API
            const apiKey = process.env.DEEPSEEK_API_KEY;
            const model = process.env.VISION_MODEL || 'deepseek-v4-flash-vision-exp';
            const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

            if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');

            console.log(`[Vision] 🤖 调用 ${model}...`);
            const aiResponse = await fetchFn(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageUrl } },
                            { type: 'text', text: '请用简洁可爱的语气描述这张图片的内容~' }
                        ]
                    }],
                    max_tokens: 1024
                })
            });

            if (!aiResponse.ok) {
                const errText = await aiResponse.text();
                throw new Error(`DeepSeek API ${aiResponse.status}: ${errText.substring(0, 200)}`);
            }

            const data = await aiResponse.json();
            const reply = data.choices?.[0]?.message?.content?.trim();

            if (!reply) throw new Error(`API返回为空: ${JSON.stringify(data).substring(0, 200)}`);

            console.log(`[Vision] ✅ AI回复 (${reply.length} chars): ${reply.substring(0, 100)}...`);
            return reply;

        } catch (err) {
            console.error(`[Vision] ❌ 处理失败: ${err.message}`);
            return '抱歉，图片分析出错了 😢 请稍后再试~';
        } finally {
            // 4. 清理临时文件
            if (localImagePath) await fs.unlink(localImagePath).catch(() => {});
        }
    }
}

module.exports = VisionPlugin;
