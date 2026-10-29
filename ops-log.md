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


## W1 正式关闭（2026-10-19）

### 提交记录

- 6adaac9 feat(W1): ModelProvider 多模型路由层
- 4b7007d chore(core): core 模块改动 + chatWorker/feishuAdapter
- 2f8db96 chore: index/gateway/aiBrain 改动
- f94df14 chore(deps): 依赖清单
- 7f5e2e9 docs(W1): 补全 .env.example + model-provider 文档 + W1 复盘
- 已 push: 064dd76..7f5e2e9

### 验收结论

测试 1/2/3/4 全过 + QQ 回归正常 + aiBrain 零改动 + .env 安全 + 代码入库。

### 遗留隐患（W4 前处理）

- GLM review_code 长输出 latency 13.9s → devPipeline 审查 timeout=10s 兜底
- 单次聊天 tokens≈1666 → W7 加每日 token 预算
- Redis 6.0.16 < BullMQ 推荐 6.2.0（非本次引入）

### 经验教训

- .env 一直安全，上次丢失非 git 泄露，疑为 git clean -fd
- 禁用：git add . / git clean -fd / git push --force
- heredoc 结束标记用独特词（MDEOF / ENVEOF / LOGEOF），不用 EOF

## W2 周一（2026-10-26）：dev_knowledge.db 建表 + L0 层

### 完成事项

1. 建表：scripts/init-dev-knowledge.js 创建三表七索引
   - dev_events（L0，12 字段）
   - dev_experience（L1，13 字段 + 外键 ON DELETE SET NULL）
   - dev_patterns（L2，6 字段，仅建表不启用）
   - WAL + foreign_keys 启用

2. 表结构验证：12+13+6 字段全部匹配，外键 dev_experience.source_event_id -> dev_events.id 正确

3. L0 层实现：core/devMemory.js 暴露 9 个方法
   - writeEvent / getUndistilled / markDistilled / markUnstructured
   - updateEventOutcome / adoptEvent / getEventById
   - stats / selfCheck
   - 风格对齐 memory.js（better-sqlite3 同步 + 预编译语句 + 事务）

4. L0 测试全绿：scripts/test-dev-memory-l0.js 5 项测试全过，测试数据自动清理

5. 三库备份扩展：scripts/backup_db.js 支持 chat_memory / maid_memory / dev_knowledge
   - 每个库保留最近 7 份
   - 备份文件可读验证通过

### 提交记录

- 1548c37 feat(W2): 新增 dev_knowledge.db 初始化脚本（三表七索引 + 自检）
- d54b9ca feat(W2): devMemory L0 层（writeEvent/getUndistilled/markDistilled/markUnstructured）
- 094ba8d feat(backup): 扩展 backup_db.js 支持 maid_memory + dev_knowledge 多库备份
- 329b076 docs(W2): 修复 ops-log 尾部重复节和粘贴脏行

### 关键发现

p3-vector 原生支持 memory_type 过滤，开发知识库的向量隔离不需要改 p3-vector 一行代码：
- user_id = 'dev_me'
- memory_type = 'dev_experience'
- point_id = 'dev_exp_<id>'（必须加前缀，避免与 chat_memory 整数 id 撞车）

W2 周四只需写 syncExperienceToVector(id) 调 /ingest。

### 遗留隐患

1. backup_db.js 已修复（commit 094ba8d），三库备份闭环

2. L1 层未开始
   - 周二写 writeExperience / searchExperience / updateEmbeddingStatus
   - 周三晚 50% 检查点，未达标砍 adoptExperience 权重逻辑

### 明日计划（10/27 周二）

- 上午：L1 五方法追加到 devMemory.js
- 下午：scripts/test-dev-memory-l1.js（含外键 ON DELETE SET NULL 验证）
- 晚上：commit + push

## W2 周二（2026-10-27）：L1 层完成

### 完成事项
- core/devMemory.js 覆盖重写，L0 9 方法 + L1 5 方法（284 行）
- scripts/test-dev-memory-l1.js 7 项测试全绿
- 外键 ON DELETE SET NULL 验证通过
- searchExperience 先用 SQLite fallback（按 task_type + adopted/ts 排序）

### 提交
- 本轮 commit hash 待补

### 周三 50% 检查点预判
- writeExperience ✅ / searchExperience ✅ / updateEmbeddingStatus ✅
- 判定：达标，周三晚不需砍单

### 周四计划
- searchExperience 从 SQLite fallback 换成 p3-vector 向量检索
- 新增 syncExperienceToVector(id) 调 /ingest
- 约定：user_id='dev_me', memory_type='dev_experience', point_id='dev_exp_<id>'

### 经验教训（累积）
- 所有 >30 行脚本用两段式：先写 /tmp/xxx.tmp.js，验证后 cp 到目标
- Node 只认 .js/.mjs/.cjs，临时文件用 .tmp.js 不用 .new

### W2 周二补充（2026-10-27 晚）：搜索埋点前置

#### 做了什么
- dev_knowledge.db 新增 dev_search_log 表（12 字段 + 3 索引）
- searchExperience 内嵌埋点，失败不阻塞主流程
- scripts/init-dev-knowledge.js 同步新表结构
- 4 张表：dev_events / dev_experience / dev_patterns / dev_search_log

#### 为什么现在做
- W7 的点阵图和策略优化依赖历史搜索数据
- 数据埋点前置，W2-W6 的搜索行为才能被记录
- 成本 15 分钟，但不做的话 W7 分析就是无米之炊

#### 埋点字段
- query / query_norm：原始查询 + 归一化（小写去标点）
- hit_count / hit_ids：命中数 + 命中的 L1 id 数组
- top_score：最高相似度（周四接向量后填充）
- adopted_hit：命中结果里是否有 adopted=1
- source：'dev' | 'qq' | 'web'（区分来源）
- latency_ms：检索耗时

#### 提交
- 1055869 feat(W2): 新增 dev_search_log 埋点表 + searchExperience 记录每次检索

#### 对后续的影响
- 周四向量同步时，searchExperience 换成 p3-vector 调用，埋点代码一行不用改
- 因为埋点在检索逻辑之外，hits 结构不变（{id, problem, solution, score}）
- W7 直接基于 dev_search_log 出点阵图和策略建议

#### 验收
- 手动触发 1 次检索，search_log 从 0 → 1，字段完整
- L0/L1 两套测试仍全绿，无回归

### 明日计划（10/28 周三）

- 上午：跑 L0+L1 两套测试确认状态（10min）
- 中午：50% 检查点，确认三核心方法在（5min）
- 晚上：休息，不写代码

### 周四计划（10/29）

- searchExperience 从 SQLite fallback 换成 p3-vector 向量检索
- 新增 syncExperienceToVector(id) 调 /ingest
- 约定：user_id='dev_me', memory_type='dev_experience', point_id='dev_exp_<id>'
- 埋点代码零改动，只改检索逻辑

## W2 周三提前完成（2026-10-27 晚）：向量同步

### 探测发现
- p3-vector 的 point_id 必须是整数（Pydantic 422 int_parsing）
- /search 返回 {id: 整数, score, content, memory_type}
- memory_type 过滤生效（2/1/0 完全符合）
- user_id 隔离生效（other_user 返回 0）

### 方案定稿
- point_id = 1_000_000_000 + L1.id（10 亿偏移，与 chat_memory 整数 id 天然隔离）
- content = `${problem}\n${solution}`
- 反查：results[i].id - 1e9 = L1.id
- taskType 过滤：向量检索 top_k 放大 3 倍，结果二次过滤后截断
- 降级：向量检索失败 → SQLite fallback

### 完成事项
- core/devMemory.js：新增 syncExperienceToVector(id)，searchExperience 改 async
- searchExperience：向量优先 + SQLite 降级 + 埋点保留（记录 top_score）
- scripts/test-dev-memory-l1.js：改 async 版（searchExperience 加 await）
- scripts/test-dev-knowledge-vector.js：新增 5 项向量测试

### 测试结果
- L0 测试：全绿
- L1 测试（async 版）：全绿
- 向量同步测试：5 项全绿
  - ingest + point_id 偏移正确
  - 向量检索命中 + score 数字
  - 埋点记录 top_score
  - taskType 过滤生效
  - 向量 API 不可达时降级为 SQLite fallback，不抛异常

### 提交
- 3d8846a feat(W2): devMemory 接入 p3-vector 向量检索

### W2 完成度
- M1 建表 ✅ / M2 L0 ✅ / M3 L1 ✅ / M3.5 埋点 ✅ / M4 向量同步 ✅
- 剩余 M5 端到端测试（周四 30 分钟）+ M6 复盘（周日 30 分钟）
- 比原计划提前 2 天

### 周四计划（10/29）
- 端到端测试脚本 scripts/test-dev-knowledge-e2e.js（L0→L1→向量→检索全链路）
- 跑一次 bootstrap 灌 20 条 L0 验证蒸馏前的入库
- W2 复盘提前到周六，周五开始 W3

### 周五计划（10/30）
- 开始 W3：蒸馏链路（prompts/dev-distill.md + core/devDistiller.js）

### W2 周三下午：端到端 + 冷启动灌入（W2 完成）

#### 端到端测试
- test-dev-knowledge-e2e.js：9 步全绿
- 链路：L0 → 模拟蒸馏 → L1 → 向量同步 → 检索命中（score 0.68）
  → 埋点 top_score → stats 对齐 → 清理
- 结论：数据层完整闭环

#### 冷启动灌入
- bootstrap-dev-knowledge.js：17 条 L0
- README 11 段 + CHANGELOG 1 段 + ops-log 5 段
- 全部 source='file', taskType='note', 待 W3 蒸馏
- 支持 --dry-run 预览，MAX_SEGMENTS=20

#### 修复
- test-dev-memory-l0.js / e2e 的 getUndistilled(10) → (100)
- 原因：17 条旧 L0 把新写的挤出 top 10 窗口
- 教训：测试假设随数据增长会失效，limit 要给足余量

#### W2 完成度：100%
- M1 建表 ✅ / M2 L0 ✅ / M3 L1 ✅ / M3.5 埋点 ✅
- M4 向量同步 ✅ / M5 E2E ✅ / M6 灌入 ✅
- 复盘待周日

#### 累计数据
- dev_events: 17（待蒸馏）
- dev_experience: 0（W3 产出）
- dev_search_log: 8+（测试埋点，保留）
- p3-vector: 3 条探测遗留（dev_me 下，不影响后续）

### 周四计划（10/29）
- 只跑四套测试确认状态（5min）
- 补 W2 复盘到 ops-log（15min）
- 不写新代码

### 周五计划（10/30）
- 正式进 W3：prompts/dev-distill.md + core/devDistiller.js
- W3 目标：把 17 条 L0 自动蒸馏成 L1

## W2 复盘（2026-10-26 ～ 10-28，提前 4 天完成）

### 与原计划对比

| 里程碑 | 原计划 | 实际 | 偏差 |
|--------|--------|------|------|
| M1 建表 | 10/27 | 10/26 | 提前 1 天 |
| M2 L0 层 | 10/28 | 10/26 | 提前 2 天 |
| M3 L1 层 | 10/28 | 10/27 | 提前 1 天 |
| M3.5 搜索埋点 | 未计划 | 10/27 | 额外完成 |
| M4 向量同步 | 10/29 | 10/27 | 提前 2 天 |
| M5 端到端 | 10/30 | 10/28 | 提前 2 天 |
| M6 冷启动灌入 | 11/01 | 10/28 | 提前 4 天 |

### 交付物清单

代码（8 个文件）：
- core/devMemory.js：L0 9 方法 + L1 5 方法 + 向量同步 + 埋点
- scripts/init-dev-knowledge.js：4 表 10 索引
- scripts/backup_db.js：三库备份扩展
- scripts/bootstrap-dev-knowledge.js：冷启动灌入
- scripts/test-dev-memory-l0.js / l1.js / knowledge-vector.js / knowledge-e2e.js：四套测试

数据库：
- dev_knowledge.db：dev_events 17 / dev_experience 0 / dev_patterns 0 / dev_search_log 25+
- p3-vector：dev_me 下 0 条（孤儿点已清理）

### 做对了什么

1. 数据隔离：三个库零耦合
2. 埋点前置：W2 就建好 dev_search_log
3. 降级机制：向量失败自动 fallback SQLite
4. 两段式写入：>30 行脚本先写 /tmp 再 cp
5. 探测先行：向量同步前先探测 4 个未知数

### 踩过的坑（W2 新增）

| # | 坑 | 教训 |
|---|-----|------|
| 10 | /tmp 下 require axios 失败 | Node 20 自带 fetch，探测脚本用 fetch 绕开 |
| 11 | 冷启动灌入后测试 FAIL | 测试假设「库里只有自己那 1 条」失效，limit 10→100 |
| 12 | point_id 字符串 422 | p3-vector 用 Pydantic 强校验，必须整数，用 1e9 偏移 |
| 13 | 测试残留 2 条 L0 + 9 个孤儿向量 | 清理逻辑放 finally，不依赖 catch + 末尾手动清 |

### p3-vector 删除接口备忘

- 端点：`POST /delete`
- 字段：`{"point_ids": [id1, id2, ...]}`（复数数组，不是 point_id 单数）
- 可用端点：`/ingest`, `/search`, `/delete`, `/health`

### W2 的关键决策

1. point_id = 1_000_000_000 + L1.id：可逆、不撞车
2. searchExperience 改 async：向量检索本质异步
3. 蒸馏留到 W3：W2 只做数据层
4. 埋点表独立：不混入 dev_events

### 对 W3 的输入

- 17 条 L0 待蒸馏（README 11 + CHANGELOG 1 + ops-log 5）
- 蒸馏 Worker 需要：getUndistilled(20) → LLM → 写 L1 → sync 向量
- 蒸馏质量决定后续检索命中率
- W3 预估耗时 2.5 小时
