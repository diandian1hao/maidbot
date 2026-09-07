# MaidBot 运维台账 (ops-log)

> 记录每次生产级故障的定位、修复、验证与经验沉淀。

---

## 2026-08-27 ｜ P0 Token 刷新递归风暴 + P1.5 可观测性体系搭建

### 现象
- pm2 logs 出现 `[API] 刷新 Token...` 以 ~130ms 间隔疯狂刷屏，1 秒 12 轮，CPU 飙升，网关被刷爆风险。

### 根因（两层叠加）
1. **负数 setTimeout 立即触发**：`core/api.js` 预约下次刷新用 `ttl - 5*60_000`。当网关偶发返回短命 token（expires_in=60s），delay = 60s − 300s = **−240s**。JS 的 setTimeout 遇负延迟按 0 处理 → 立即 firing。
2. **短命 token 恒成立条件**：`getToken()` 里「距过期不足 5 分钟就刷」对 60s token 永远成立，外部调用也火上浇油。
   → 拿到短命 token → 定时器立即触发 → 再刷 → 又是短命 → 递归风暴，直到某次拿到 120 分钟 token 才停。

### 修复（core/api.js，6 处行级手术）
- 新增 `_lastRefreshAt` 时间戳。
- `getToken()` 加防连转锁：token 仍有效且 60s 内刚刷过 → 直接复用。
- 延迟钳制：`delay < 30s` 时改为 `max(ttl/2, 10s)`，杜绝负延迟。
- 短命 token 打 warn 日志便于观测。
- 刷新成功后 `setTokenExpiry()` 同步给健康探针。
- 顺手修 `core/alert.js` env 名 bug（`ALERT_OWNER_QQ` → `ALERT_OWNER_ID`，名实相符）。

### P1.5 健康探针挂钩（core/bot.js 5 处 + index.js 1 处）
- `on('open')` → `health.setWs(true)`
- `on('error')` / `onClose` → `health.setWs(false)`
- `case 11`(心跳 ACK) → `health.heartbeat()` ← 与用户流量解耦的核心
- index.js dispatch 移除错误的 `health.heartbeat()`（改由 op=11 驱动）

### 验证证据
- 修复前：1 秒 12 轮风暴。
- 修复后：`16:37:11 刷新 → 16:47:03 刷新`，整整 10 分钟 1 次（API 调用量 ↓99%+）。
- `/ready` (端口 9800) 返回：`{"status":"ready","checks":{"ws":true,"db":true,"token":true,"heartbeat":true},"uptime":68,"restartCount":1}` 四字段全绿。
- 告警通路：`[API] ✅ 已回复: [MaidBot 告警]` 真实发送到 owner QQ 私聊。

### 经验沉淀（可复用原则）
1. **任何用动态计算值做 setTimeout/setInterval 延迟的地方，必须钳制下界**（`Math.max(delay, MIN)`），否则负数/极小值会引发立即触发的递归风暴。
2. **刷新类逻辑必须有防重入锁 + 最小间隔**，避免「恒成立条件」下的自我喂养循环。
3. **健康探针的心跳信号应与用户流量解耦**（用协议层 ACK 而非业务事件驱动），否则空闲期会被误判为死亡。
4. **环境变量命名必须名实相符**，否则注入静默失效，排查成本极高。

### 涉及文件备份
- core/api.js.bak.* / core/bot.js.bak.* / core/alert.js.bak.* / index.js.bak.* （同目录，带时间戳）
