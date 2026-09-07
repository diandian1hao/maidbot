const client = require('prom-client');

// 创建独立 Registry，避免污染默认全局
const register = new client.Registry();

// ====== P1 原有指标（保持不变）======

// 1. 消息计数
const messagesTotal = new client.Counter({
    name: 'maidbot_messages_total',
    help: 'Total number of messages received',
    labelNames: ['type'],
    registers: [register]
});

// 2. API 延迟直方图
const apiLatency = new client.Histogram({
    name: 'maidbot_api_latency_seconds',
    help: 'API call latency in seconds',
    labelNames: ['model', 'status'],
    buckets: [0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30],
    registers: [register]
});

// 3. Token 消耗
const tokensTotal = new client.Counter({
    name: 'maidbot_tokens_total',
    help: 'Total tokens consumed',
    labelNames: ['model', 'direction'],
    registers: [register]
});

// 4. 错误计数
const errorsTotal = new client.Counter({
    name: 'maidbot_errors_total',
    help: 'Total errors occurred',
    labelNames: ['plugin', 'error_type'],
    registers: [register]
});

// 5. WS 连接状态
const wsState = new client.Gauge({
    name: 'maidbot_ws_state',
    help: 'WebSocket connection state',
    registers: [register]
});

// 6. 活跃用户数
const activeUsers = new client.Gauge({
    name: 'maidbot_active_users',
    help: 'Number of active users in current session window',
    registers: [register]
});

// 7. PM2 重启次数
const restartCount = new client.Gauge({
    name: 'maidbot_pm2_restarts',
    help: 'PM2 process restart count',
    registers: [register]
});
restartCount.set(Number(process.env.PM2_RESTART_TIME) || 0);

// ====== P3 双库联动新增指标 ======

// 8. 搜索耗时（分阶段：encode / qdrant / total）
const searchDuration = new client.Histogram({
    name: 'maidbot_search_duration_seconds',
    help: 'Vector search duration by stage',
    labelNames: ['stage'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register]
});

// 9. 搜索请求计数
const searchTotal = new client.Counter({
    name: 'maidbot_search_total',
    help: 'Total vector search requests',
    labelNames: ['status'],
    registers: [register]
});

// 10. 记忆写入计数
const memoryWriteTotal = new client.Counter({
    name: 'maidbot_memory_write_total',
    help: 'Total memory write operations',
    labelNames: ['type', 'status'],
    registers: [register]
});

// 11. 双库同步积压
const syncPending = new client.Gauge({
    name: 'maidbot_sync_pending',
    help: 'Records pending or failed sync to Qdrant',
    registers: [register]
});

// 12. 同步失败计数
const syncFailures = new client.Counter({
    name: 'maidbot_sync_failures_total',
    help: 'Total Qdrant sync failures',
    registers: [register]
});

// 13. 记忆总量（按类型）
const memoryCount = new client.Gauge({
    name: 'maidbot_memories',
    help: 'Memory record count by type',
    labelNames: ['type'],
    registers: [register]
});

// 14. 向量服务健康
const vectorServiceUp = new client.Gauge({
    name: 'maidbot_vector_service_up',
    help: 'Vector service health (1=up, 0=down)',
    registers: [register]
});

// ===== 对外暴露的便捷方法 =====
module.exports = {
    register,

    // P1 原有方法
    msg: (type) => messagesTotal.inc({ type }),
    latency: (model, status, seconds) => apiLatency.observe({ model, status }, seconds),
    token: (model, direction, count) => tokensTotal.inc({ model, direction }, count),
    error: (plugin, errorType) => errorsTotal.inc({ plugin, error_type: errorType }),
    ws: (connected) => wsState.set(connected ? 1 : 0),
    users: (count) => activeUsers.set(count),

    // P3 新增方法
    searchDuration,
    searchTotal,
    memoryWriteTotal,
    syncPending,
    syncFailures,
    memoryCount,
    vectorServiceUp,
};
