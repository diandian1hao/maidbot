const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../data/owner.json');

module.exports = {
  save(openid) {
    if (!openid) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ openid, savedAt: new Date().toISOString() }, null, 2));
  },
  load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).openid; }
    catch { return null; }
  },
};
