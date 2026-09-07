require('dotenv').config({ override: true });
const http = require('http');
const logger = require('./utils/logger');

const PORT = parseInt(process.env.WATCHDOG_PORT, 10) || 9801;
const POLL_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL, 10) || 15000;

const TARGETS = [
  { name: 'p1-maidbot', url: 'http://127.0.0.1:9800/health' },
  { name: 'p3-vector',  url: 'http://127.0.0.1:8000/health' },
];

const state = {};
TARGETS.forEach(t => {
  state[t.name] = { up: false, lastCheck: null, consecutiveFails: 0, lastError: null };
});

async function probe(target) {
  const s = state[target.name];
  try {
    const res = await fetch(target.url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const wasDown = !s.up;
      s.up = true;
      s.consecutiveFails = 0;
      s.lastCheck = Date.now();
      s.lastError = null;
      if (wasDown) logger.info(`[Watchdog] ✅ ${target.name} recovered`);
    } else {
      fail(target, `HTTP ${res.status}`);
    }
  } catch (e) {
    fail(target, e.message);
  }
}

function fail(target, reason) {
  const s = state[target.name];
  const wasUp = s.up;
  s.up = false;
  s.consecutiveFails += 1;
  s.lastCheck = Date.now();
  s.lastError = reason;
  if (wasUp) logger.error(`[Watchdog] 🔴 ${target.name} DOWN: ${reason}`);
  if (s.consecutiveFails === 3) {
    logger.error(`[Watchdog] 🚨 ${target.name} CRITICAL: 连续 ${s.consecutiveFails} 次失败`);
  }
}

async function tick() {
  for (const t of TARGETS) await probe(t);
}

const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ts: Date.now(), targets: state }));
  } else if (req.url === '/metrics') {
    let lines = '# HELP maidbot_service_up Service health (1=up, 0=down)\n# TYPE maidbot_service_up gauge\n';
    for (const [name, s] of Object.entries(state)) {
      lines += `maidbot_service_up{service="${name}"} ${s.up ? 1 : 0}\n`;
    }
    lines += '# HELP maidbot_watchdog_last_check_ts Last probe timestamp\n# TYPE maidbot_watchdog_last_check_ts gauge\n';
    for (const [name, s] of Object.entries(state)) {
      lines += `maidbot_watchdog_last_check_ts{service="${name}"} ${s.lastCheck || 0}\n`;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(lines);
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  logger.info(`[Watchdog] started on :${PORT} (/status /metrics)`);
});

tick().then(() => setInterval(tick, POLL_INTERVAL));

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
