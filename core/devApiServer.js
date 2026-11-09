const express = require('express');
const logger = require('../utils/logger');
const { devChat } = require('./devPipeline');
const dm = require('./devMemory');

const app = express();
app.use(express.json());
const PORT = process.env.DEV_API_PORT || 3002;
const TOKEN = process.env.DEV_API_TOKEN;

const auth = (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/api/dev/chat', auth, async (req, res) => {
  const { query, userId = 'api_user', projectName = 'api_project', isIteration = false, contextCode = '' } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const result = await devChat(query, { userId, projectName, isIteration, contextCode });
    // 也可以在这里顺手更新黑板书
    dm.updateSessionCode(userId, projectName, result.reply);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function startDevApi() {
  if (!TOKEN) return;
  app.listen(PORT, '0.0.0.0', () => logger.info(`[DevAPI] 🚀 网关启动 :${PORT}`));
}
module.exports = { startDevApi };
