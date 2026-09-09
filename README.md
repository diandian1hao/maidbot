# 🤖 MaidBot

![CI](https://github.com/diandian1hao/maidbot/actions/workflows/ci.yml/badge.svg)

> 傲娇女仆系 QQ 机器人 × Web 双端智能体
> 插件责任链 · 双库联动记忆 · 向量检索 · 云端 7×24 自持驻守 · 全链路可观测

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-SSE%20Streaming-black)
![PM2](https://img.shields.io/badge/PM2-Daemon%20%2B%20Watchdog-blue)
![SQLite](https://img.shields.io/badge/SQLite-WAL%20Mode-lightgrey)
![QQ Bot](https://img.shields.io/badge/QQ%20Bot-Official%20Gateway-green)
![Uptime](https://img.shields.io/badge/Uptime-7%C3%9724%20Cloud-brightgreen)

---

## ✨ 亮点一览

| 能力 | 说明 |
|------|------|
| 🔁 **双端同步** | QQ 端（官方网关 WebSocket）与 Web 端（Express + SSE 流式）共用同一条插件责任链，行为完全一致 |
| 🔌 **插件模块化** | 优先级责任链 + 统一 `handleMessage` 契约，热插拔式设计，内置 7 个插件 |
| 💾 **双库联动** | 对话记忆库 + 长期记忆库，Worker 每 30s 增量同步、每 1800s 生成摘要，SQLite WAL 模式 |
| 🔍 **向量检索** | 独立向量服务 `p3-vector`(:8000)，按用户隔离的 topK 语义召回，异步不阻塞主链 |
|  **Web 客户端** | 零 CDN 依赖单页应用，SSE 逐字流式输出，展示响应插件来源；双层限流（个人 10 次/天 + 全站 100 次/天） |
| 🛡 **云端自持** | PM2 守护 + 独立 watchdog + 健康探针 + 告警通道 + 日志轮转 + 6 小时定时备份 + 优雅退出 |
| 📊 **可观测性** | 统一 metrics 采集，`:9800` 探针暴露 `/health /ready /state /metrics` |

---

## 🏗️ 总体架构

```
   QQ 官方网关 ◄──WSS──► ┌─────────────────────────────┐
                         │        index.js 主控         │
                         │  dispatch() 事件分发          │
                         │  pipeline.register() 管道注册 │
   Web 浏览器  ◄─SSE──►  └──────────────┬──────────────┘
   (:3001 web 插件)                     │
                         ┌──────────────▼──────────────┐
                         │  core/pipeline.js 共享管道    │
                         │  processMessage()            │
                         │  向量召回 → 插件责任链 → 记忆写入 │
                         └──────────────┬──────────────┘
                         ┌──────────────▼──────────────┐
                         │  base → persona → weather    │
                         │  → vision → schedule         │
                         │  → aiBrain（LLM 兜底脑）       │
                         └──────────────┬──────────────┘
                         ┌──────────────▼──────────────┐
                         │      双库联动 Worker           │
                         │   sync 30s / summary 1800s   │
                         ├──────────────────────────────┤
                         │ chat_memory.db  对话记忆 (WAL) │
                         │ maid_memory.db  长期记忆 (WAL) │
                         │ p3-vector :8000 向量检索服务    │
                         └──────────────────────────────┘
   自持层: PM2 守护 + watchdog + 健康探针 :9800 + alert 告警
           + pm2-logrotate 日志轮转 + 6h 定时 DB 备份

```

---

## 📁 目录结构

```
maidbot/
├── index.js                 # 主入口：事件分发 + 共享管道注册 + P0 优雅退出 + 定时备份
├── core/
│   ├── bot.js               # QQ 官方网关：WebSocket 连接 / 心跳保活 / 断线重连
│   ├── manager.js           # 插件管理器：扫描加载 + 优先级排序
│   ├── pipeline.js          # 双端共享消息管道注册中心
│   ├── memory.js            # SQLite 记忆存储（WAL 模式）
│   ├── memoryRepository.js  # 记忆仓库：读写 + 向量检索接口
│   ├── worker.js            # 双库联动 Worker（同步 / 摘要）
│   ├── health.js            # 健康探针 :9800（/health /ready /state /metrics）
│   └── alert.js             # 异常告警通道（info / critical）
├── plugins/
│   ├── base.js              # 基础指令插件
│   ├── persona.js           # 人设层：傲娇女仆语气注入
│   ├── weather.js           # 天气插件（QWeather API）
│   ├── vision.js            # 图像理解插件（多模态）
│   ├── schedule.js          # 定时任务插件（每日早报等）
│   ├── aiBrain.js           # LLM 对话兜底脑（结合记忆上下文）
│   └── web-server.plugin.js # Web 客户端（Express + SSE + 双层限流）
├── llm.js                   # LLM 接口封装（超时 + 重试）
├── metrics.js               # 统一 metrics 采集（消息量 / 类型 / 重启等）
├── watchdog.js              # 独立看门狗进程（主进程异常自愈）
├── ecosystem.config.js      # PM2 编排配置（多进程：maidbot / p3-vector / watchdog）
├── scripts/                 # 运维脚本（backup_db.js 等）
├── utils/                   # logger 等基础工具
├── prompts/                 # 人设与系统提示词模板
├── models/                  # 向量化模型资源
├── backups/                 # 数据库定时备份目录
└── logs/                    # 运行日志（pm2-logrotate 轮转）

```

---

## 🔌 插件系统

**责任链契约**：每个插件实现 `handleMessage(msgData, bot)`——返回字符串即作为回复并终止链路；返回 `null` 则放行给下一个插件。按 `priority` 升序执行，`aiBrain` 作为兜底脑置于链尾，保证任何消息都有响应。

| 插件 | 定位 | 说明 |
|------|------|------|
| `base.js` | 基础指令 | 帮助 / 管理指令入口 |
| `persona.js` | 人设层 | 傲娇女仆语气与角色一致性 |
| `weather.js` | 天气查询 | 对接 QWeather API |
| `vision.js` | 图像理解 | 多模态图片解析 |
| `schedule.js` | 定时任务 | 每日早报（城市可配置）等 |
| `aiBrain.js` | 对话兜底脑 | LLM 生成 + 记忆上下文融合 |
| `web-server.plugin.js` | Web 客户端 | 仅提供 HTTP/SSE 服务，不参与抢答（`handleMessage` 恒返回 `null`） |

`msgData.source` 字段区分消息来源（`'qq'` / `'web'`），插件可按端差异化处理。

---

## 🔁 双端同步：共享管道

QQ 端与 Web 端不再各写一套逻辑，而是注册/复用同一条处理管道（向量召回 → 插件责任链 → 记忆写入）：

```js
// index.js：主控注册共享管道
pipeline.register((userId, text, opts) => processMessage(userId, text, opts));

// plugins/web-server.plugin.js：Web 端复用同一条链
const result = await pipeline.chat(userId, message, { source: 'web' });
// result.reply → SSE 流式回写；result.plugin → 前端展示响应插件来源

```

Web 用户以 `web_<IP>` 作为隔离 ID，记忆召回与 QQ 用户互不串扰。

---

## 💾 双库联动与向量检索

- **chat_memory.db**：对话记忆库（SQLite WAL 模式，支持并发读）
- **maid_memory.db**：长期记忆库（摘要沉淀）
- **Worker 联动**：`sync=30s` 增量同步、`summary=1800s` 周期摘要，短期记忆自动沉淀为长期记忆
- **向量检索**：`p3-vector` 独立进程监听 `:8000`，`memoryRepository.search(userId, text, { topK: 3 })` 按用户隔离召回，异步执行不阻塞回复主链
- **优雅退出保障**：SIGTERM/SIGINT 时先停 Worker 与 WebSocket，再执行 `wal_checkpoint(TRUNCATE)` 后关闭 SQLite，杜绝数据丢失

---

## 🌐 Web 客户端与流控

- **地址**：`http://<host>:3001`（Nginx 反代至 80 端口亦可）
- **流式体验**：SSE 逐字输出（20ms/字节奏），响应结束后展示 `⚙️ 由插件「xxx」响应`
- **双层限流**（内存态，按自然日重置）：

| 维度 | 额度 | 超限行为 |
|------|------|----------|
| 个人（按真实 IP，`trust proxy` 穿透 Nginx） | 10 次/天 | 429 + 前端锁定输入 |
| 全站（所有 Web 访客共享） | 100 次/天 | 429 + 页脚公示剩余量 |

- **状态接口**：`GET /api/status` → `{ remaining, globalRemaining }`，页脚实时公示全站余量

---

## 🛡️ P0–P5 工程里程碑（全部落地）

| 阶段 | 目标 | 落地实现 |
|------|------|----------|
| **P0** 云端稳定性加固 | 不挂、挂了能自愈 | PM2 守护 + watchdog；SIGTERM/SIGINT 优雅退出（停 WS → WAL checkpoint → 关库）；pm2-logrotate 日志轮转；`scripts/backup_db.js` 每 6 小时定时备份 |
| **P1** 健康探针与告警 | 挂了第一时间知道 | `core/health.js` :9800（`/health /ready /state /metrics`）；`core/alert.js` info/critical 双级告警 |
| **P2** 可观测性 | 量化系统表现 | `metrics.js` 统一采集（消息量 / C2C·GROUP 分类 / 重启次数）；Prometheus 风格 `/metrics`；Web 端 `/api/status` 状态面 |
| **P3** 向量检索 | 记得住聊过什么 | `p3-vector` 独立向量服务；topK=3 用户隔离语义召回；异步不阻塞 |
| **P4** 记忆摘要与分层调度 | 长期记忆 | 双库联动 Worker：30s 同步 + 1800s 摘要；短期/长期分层沉淀 |
| **P5** 性能与体验 | 快且稳 | SSE 流式输出；LLM 超时 + 重试；双层限流保护资源；Nginx `X-Accel-Buffering: no` 打通流式 |

---

## 🩺 可观测性与系统自持

```bash
# 健康探针
curl http://127.0.0.1:9800/health
curl http://127.0.0.1:9800/metrics

# Web 流式自检
curl -N -X POST http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"你好"}'

# 进程编排（maidbot / p3-vector / watchdog 三进程）
pm2 status && pm2 logs maidbot

```

- **自愈链路**：进程崩溃 → PM2 自动拉起；PM2 之外异常 → watchdog 兜底；启动失败 → alert 告警
- **日志治理**：pm2-logrotate 自动轮转，防止磁盘撑爆
- **数据保障**：6 小时定时备份至 `backups/`，优雅退出时 WAL checkpoint 刷盘

---

## 🚀 快速开始

```bash
git clone <your-repo-url> && cd maidbot
npm install
cp .env.example .env            # 填入 QQ 凭证 / LLM Key / 天气 Key 等
cp config.example.json config.json
pm2 start ecosystem.config.js
pm2 save

```

| 环境变量 | 用途 |
|----------|------|
| `APP_ID` / `APP_SECRET` | QQ 官方机器人凭证 |
| `WEB_PORT` | Web 客户端端口（默认 3001） |
| `PLUGIN_DIR` | 插件目录（默认 `./plugins`） |
| 其余 | LLM Key、QWeather Key、向量服务地址等，见 `.env.example` |

> 依赖 Node.js ≥ 18；向量服务与 watchdog 由 `ecosystem.config.js` 一并编排。

---

## 📈 运行指标（简历素材模板）

- **连续运行**：7×24 云端驻守，崩溃自愈平均恢复 < 5s
- **插件规模**：7 个内置插件，责任链热插拔
- **双端入口**：QQ 网关 WSS + Web SSE，共享管道零逻辑分叉
- **记忆体系**：双库联动 + 向量召回，用户级隔离
- 实时数据以 `/metrics` 与 `pm2 status` 为准

---

## 📝 版本与运维记录

- 变更日志见 [CHANGELOG.md](./CHANGELOG.md)
- 运维事件记录见 [ops-log.md](./ops-log.md)

## ⚠️ 免责声明

本项目为个人学习与工程实践作品，部署与使用请遵守 QQ 开放平台及所接入模型服务的相关规范。
