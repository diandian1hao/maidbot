require('dotenv').config();
const fs = require('fs');
const { callVision } = require('./lib/dashscope');

const file = process.argv[2] || '/tmp/test.png';
const question = process.argv[3] || '用一句话描述这张图';

const buf = fs.readFileSync(file);
const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';

callVision({ base64: buf.toString('base64'), mime, text: question })
  .then((t) => console.log('✅ 视觉说:', t))
  .catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
