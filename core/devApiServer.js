const express = require('express');
const logger = require('../utils/logger');
const { devChat } = require('./devPipeline');
const dm = require('./devMemory');

const app = express();
app.use(express.json());
const PORT = process.env.DEV_API_PORT || 3002;
const TOKEN = process.env.DEV_API_TOKEN;

// 鉴权中间件
const auth = (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ================= 自定义外部 API (保留) =================
app.post('/api/dev/chat', auth, async (req, res) => {
  const { query, userId = 'api_user', projectName = 'api_project' } = req.body;
  try {
    const result = await devChat(query, { userId, projectName });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= 🆕 OpenAI 兼容接口 (适配 DSH 等工具) =================
app.post('/v1/chat/completions', auth, async (req, res) => {
  const { messages, stream = false } = req.body;
  
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing messages' });
  }

  // 1. 提取用户的最后一条提问
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const query = lastUserMsg ? lastUserMsg.content : '你好';

  // 2. 🆕 解析项目信息（支持 group/project 格式）
  let rawProjectName = req.headers['x-project-name'] || 'dsh-app';
  let groupName = 'common';
  let projectName = rawProjectName;

  // 如果 DSH 无法传 Header，尝试从系统提示词里抓取 PROJECT: xxx
  const sysMsg = messages.find(m => m.role === 'system');
  if (sysMsg && sysMsg.content.includes('PROJECT:')) {
    const match = sysMsg.content.match(/PROJECT:\s*([a-zA-Z0-9_\-\/]+)/);
    if (match) rawProjectName = match[1];
  }

  if (rawProjectName.includes('/')) {
    const parts = rawProjectName.split('/');
    groupName = parts[0].trim();
    projectName = parts[1].trim();
  }

  // 3. 🆕 自动挂载黑板与活跃状态 (确保会话存在)
  const userId = 'dsh_user';
  let activeSession = dm.getActiveSession(userId);
  
  if (!activeSession || activeSession.project_name !== projectName || activeSession.group_name !== groupName) {
    // 如果当前活跃项目不匹配，强行在后台切换过去
    dm.switchProjectWorkspace(userId, `${groupName}/${projectName}`);
    activeSession = dm.getActiveSession(userId);
    logger.info(`[OpenAI-Adapter] 已自动切换 DSH 目标项目: [${groupName}] ${projectName}`);
  }

  // 获取黑板代码
  const lastCode = activeSession ? (activeSession.last_code || '') : '';
  
  // 判断是否属于追问/修改（如果当前输入包含特定词汇且黑板有代码）
  const isIteration = /报错|修改|不对|错误|换个|改成|优化|重写|继续/i.test(query);
  const contextCode = isIteration ? lastCode : '';

  logger.info(`[OpenAI-Adapter] 收到 DSH 请求 | 组:${groupName} | 项目:${projectName} | 迭代:${isIteration}`);

  try {
    // 4. 调用你的核心 Pipeline（宪法和 L1 检索会在内部自动挂载）
    const result = await devChat(query, { userId, groupName, projectName, isIteration, contextCode });
    
    // 5. 更新黑板（将最新代码写入 session）
    dm.updateSessionCode(userId, projectName, result.reply);

    // 6. 排版组装
    let finalContent = `### 💻 生成方案\n\n${result.reply}\n\n---\n\n### 🔍 MaidBot 审查意见\n\n`;
    if (result.review && result.review !== '跳过审查') {
      const reviewLines = result.review.split('\n').filter(l => l.trim() !== '');
      finalContent += reviewLines.map(line => `> ${line}`).join('\n');
    } else {
      finalContent += `> 审查通过，无明显漏洞。`;
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // 防止 Nginx 缓冲

      const chunks = finalContent.split(/(?<=\n)/); 
      for (const chunk of chunks) {
        const data = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'maidbot-brain',
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
        };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        await new Promise(r => setTimeout(r, 10));
      }
      
      const doneData = {
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'maidbot-brain', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      res.write(`data: ${JSON.stringify(doneData)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'maidbot-brain',
        choices: [{ index: 0, message: { role: 'assistant', content: finalContent }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  } catch (e) {
    logger.error(`[OpenAI-Adapter] 失败: ${e.message}`);
    if (stream) { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); } 
    else { res.status(500).json({ error: e.message }); }
  }
});

function startDevApi() {
  if (!TOKEN) return;
  app.listen(PORT, '0.0.0.0', () => logger.info(`[DevAPI] 🚀 网关启动 :${PORT} (已接入项目组与黑板机制)`));
}
module.exports = { startDevApi };
