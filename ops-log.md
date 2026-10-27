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
