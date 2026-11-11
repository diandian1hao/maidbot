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

## W3 复盘（2026-11-02 ～ 11-08，提前 4 天完成）

### 目标完成情况
- [x] prompts/dev-distill.md
- [x] core/devDistiller.js (含 JSON 提取、降级逻辑)
- [x] 手动灌 17 条 L0，全部成功转化为 L1
- [x] index.js 挂载 30 分钟定时蒸馏任务

### 核心突破
1. **全链路跑通**：L0 提取 -> GLM-4-Flash 蒸馏 -> JSON 校验 -> 写 L1 -> 同步 p3-vector。
2. **零成本蒸馏**：全程使用免费的 glm-4-flash，平均延迟 3-9 秒。
3. **高稳定性提取**：`extractJSON` 采用首尾 `{}` 截取法，完美规避了 LLM 输出多余 Markdown 标记导致 JSON.parse 崩溃的问题。
4. **全自动化**：不再需要手动触发脚本，定时器每 30 分钟自动处理。

### 当前数据状态
- dev_events: 17 (distilled=17, unstructured=0)
- dev_experience: 17 (全部 embedding_status='done')
- p3-vector: 17 (完全对应，无孤儿点)

### 经验与坑
- 大模型提取经验时，如果原文是“架构文档”或“目录结构”，提取出的 `problem` 依然很准（如“系统架构设计”）。这说明直接对文档进行蒸馏是可行的，W6 的冷启动方向是对的。

### 下一步（W4）
- 实现 `devPipeline` 共享管道。
- 链路：用户输入 -> 提取检索词 -> 查 L1 -> 生成代码(DeepSeek) -> 异模型审查(GLM) -> 返回。
# MaidBot 自我 Coding · W5 开发总结

> **周期**：2026-11-06
> **主题**：QQ 移动端挂载（devPipeline 落地、排版优化、清理接口）
> **结果**：原计划 11/22 完成，实际 11/06 完成，**提前 16 天**
> **提交**：2+ commits

---

## 一、目标与完成情况

W5 的目标是将 W4 建立的 `devPipeline` 真正推向移动端，让你脱离电脑束缚。

| 核心能力 | 实现状态 | 说明 |
|---------|---------|------|
| QQ 插件挂载 | ✅ 完成 | 新增 `plugins/dev-assistant.plugin.js` |
| 基础指令 | ✅ 完成 | 拦截 `/dev <需求>`，触发完整的生成+审查流 |
| 移动端排版 | ✅ 完成 | 去除 Markdown 符号，重排输出顺序（代码优先） |
| 长文本处理 | ✅ 完成 | 超长代码截断前1000字，完整版落盘为本地 md 文件 |
| 状态与清理 | ✅ 完成 | 新增 `/dev status` 和 `/dev clean` 接口 |

---

## 二、遇到的问题与解决方式（平台踩坑）

### 问题 1：QQ 官方指令面板的死板限制
- **现象**：尝试在 QQ 开放平台配置底部“指令菜单”，期望实现“点击按钮后自动带入参数”。但 QQ 官方限制指令文本不能包含空格，且点击发送后会强制截断，用户无法接着输入。
- **尝试解法**：查阅文档发现可使用 `<qqbot-cmd-input>` 标签。但在纯文本回复下该标签渲染极不稳定，且需要繁琐的 URL Encode。
- **最终解法**：**降维打击，回归极简**。放弃折腾平台级快捷菜单。直接依赖用户手动输入 `/dev <需求>`。在代码层面，使用 `text.startsWith('/dev')` 和 `text.slice(4).trim()` 进行高度兼容，无论用户是否加空格、是否连写，都能精准提取需求。事实证明，在手机上打几个字远比去层级菜单里找按钮更高效。

### 问题 2：手机屏幕上“无法阅读的代码块”
- **现象**：DeepSeek 生成的代码默认带有 Markdown 代码块标识（```）。直接发送到 QQ，手机端不渲染，满屏都是反引号；且几千字的代码+审查意见远超 QQ 单条消息长度上限。
- **解法**：
  1. **去除符号**：使用正则 `.replace(/```[a-z]*/g, '')` 直接在服务端剔除代码块标识。
  2. **逻辑重排**：调整输出结构为 **头部（模型/耗时） -> 代码（第一诉求） -> 审查（辅助参考）**。
  3. **智能截断落盘**：若总长度超过 1500 字，直接在手机上展示前 1000 字的代码，并提示“完整内容已存入 logs/dev-output/xxx.md”。保证你在手机端既能看核心逻辑，又不会丢失任何细节。

### 问题 3：临时文件爆炸的隐患
- **现象**：每次调用都会生成一个 `.md` 文件，随着时间推移会占满服务器磁盘。
- **解法**：新增 `/dev clean` 指令。自动扫描 `logs/dev-output/` 目录，清理 24 小时之前的文件，做到一键打扫战场。同时也避免了无关日志对开发库的视觉污染。

---

## 三、架构意义与下一步计划

### 3.1 为什么 W5 是一个里程碑？
从 W1 到 W4，你的系统一直停留在 Linux 命令行里。它再聪明，也只能在你坐在电脑前敲终端时才能发挥作用。
W5 接入 QQ 后，**真正打破了“时间与空间”的物理限制**。
你可以在地铁上、咖啡馆里，把碎片化的灵感直接丢给 `devPipeline`，让它调动你的历史知识库去生成代码。

### 3.2 下一步：W6（冷启动扩充与调优）
- 目前知识库（L1）有 18 条经验，还不够。
- W6 的目标是：编写更高级的提取脚本，把过往几个月的 Git Log、Commit 记录批量灌入 L0，让 L1 突破 50+ 条。
- 对检索精排参数（`rankHits` 权重）进行微调，实测 Top-3 召回的准确率。


## W6 开发总结（2026-11-08，提前 14 天完成）

### 核心任务
1. 编写 `bootstrap-git.js`，从 Git 历史提取 feat 和 fix 记录，成功灌入 15 条高价值 L0 并全部蒸馏成功。
2. 编写 `eval-search.js`，建立检索召回率评测标准，发现“重复项霸屏”与“知识缺口”问题。
3. 将语义去重逻辑下沉到 `core/devMemory.js` 的底层，彻底解决同义经验重复问题。
4. 掌握“缺口补录”思维：手动 writeEvent 补充了异模型、Git 历史、孤儿点等核心架构经验，评测得分飙升至 0.894。

### 数据状态
- L1 经验库突破 50 条大关，涵盖了架构设计、Bug 修复、踩坑经验。
- 搜索日志（dev_search_log）持续记录，为未来的图表分析积攒数据。

### 架构启示
- **垃圾进，垃圾出**。大模型的智力再高，也需要高质量的结构化经验。
- 评测脚本（eval-search）是系统进化的标尺，以后每次修改核心算法，都要跑一遍看召回率。

## W6 详细开发日志（2026-11-08）：冷启动与检索调优

### 一、Git 历史冷启动（数据扩充）
**1. 痛点**：W5 结束时，系统只有 37 条经验，且大多是关于项目文档的总结，缺乏真实代码开发的踩坑记录。
**2. 脚本开发**：编写了 `scripts/bootstrap-git.js`。
**3. 核心过滤策略**：
   - 获取 `git log -n 100`。
   - **白名单机制**：只提取以 `feat` 或 `fix` 开头的 commit message，坚决过滤 `docs` 和 `chore`（避免 AI 提取出“更新了文档”这种垃圾经验）。
   - **长度校验**：剔除字数少于 15 字的无意义提交。
**4. 成果**：从 40 条提交中精准提取出 15 条核心代码变更，成功写入 L0 库，并 100% 蒸馏成 L1。

### 二、检索召回率评测体系（eval-search.js）
**1. 痛点**：系统虽能检索，但“准不准、好不好用”缺乏量化标准。
**2. 脚本开发**：编写了 `scripts/eval-search.js`。
   - 预设了 5 个极具代表性的业务问题（PM2日志、异模型、SSE断流、孤儿点、Git冷启动）。
   - 自动调用 `searchExperience`，打印 Top-3 的经验和向量 Score。
**3. 首次跑测暴露的问题**：
   - **重复项霸屏**：问“PM2日志”时，命中了两条完全一样的经验，挤占了其他可能有用的经验。
   - **知识盲区**：问“异模型审查”和“孤儿点”时，由于数据库里根本没有这部分的详细记录，AI 只能靠向量相似度乱蒙，得分极低（0.5左右）。

### 三、语义去重逻辑下沉
**1. 问题根源**：W4 写的 `rankHits` 精排函数虽然包含去重，但 `eval-search.js` 直接调用的底层 `devMemory.searchExperience()`，绕过了它。
**2. 解决方案**：直接在 `core/devMemory.js` 的 `searchExperience` 返回结果前，加入一道强力的**语义去重防线**。
   - 规则：如果两个问题的 `problem` 字段完全一样，或者存在包含关系，只保留最高分的那一条。
**3. 效果**：二次跑测时，PM2 的重复项被成功剔除。

### 四、知识缺口补录（Teach the AI）
**1. 洞察**：向量检索的本质是“字面和语义的相似度”，如果数据库里没有精确的知识，AI 变不出魔法。
**2. 手动喂食**：为了让系统掌握核心架构，我手动编写了 3 条极具含金量的 L0 经验，并触发蒸馏：
   - 异模型审查的实现方案。
   - Git 历史转经验的具体脚本做法。
   - 孤儿点的处理机制（反查 L1，过滤，调 `/delete`）。
**3. 惊人回报**：补录后再次跑评测，“异模型”的得分直接飙升至 **0.770**，“孤儿点”的得分更是达到了惊人的 **0.894**，全部精准命中核心方案！

### 五、W6 架构启示
- **数据质量决定 AI 智商**：Prompt 写得再花哨，不如在 L0 里存一条精准的“问题+方案”。
- **评测先行**：以后系统每次升级（哪怕是更换了嵌入模型），必须跑一遍 `eval-search.js`，防止智商退化。
- **持续运维**：开发过程中，遇到好的解决方案，要顺手通过 QQ 发给机器人存起来，这才是“自我进化”的真谛。


## W7 详细开发日志（2026-11-09）：生命演化与网关接入

### 一、反馈进化：生命演化引擎
1. **字段扩充**：在 `dev_experience` 表新增 `used_count`（命中次数）、`last_used_ts`（最后活跃时间）、`is_permanent`（永久保留标记）。
2. **新陈代谢机制**：
   - 淘汰：定时任务每天凌晨扫描 `last_used_ts` 超过 365 天、未采纳、非永久的经验，将其 `reusable` 置为 `0`（软删除）。
   - 续命：`searchExperience` 命中时，自动刷新该条经验的 `last_used_ts`（续命 365 天）。
   - 永生：被命中满 6 次，自动将 `is_permanent` 置为 `1`，获得免死金牌。
3. **向上蒸馏（L1->L2）**：
   - 新增 `core/patternDistiller.js`。
   - 后台每 2 小时扫描 `used_count == 3` 的高频经验，调用 GLM 提取通用规律，写入 `dev_patterns`（L2 表）。

### 二、架构升级：统一开发 API 网关
1. **痛点**：过去的云地同步想法太狭隘，只能做数据导出；真正的需求是「逻辑与算力同步」。
2. **实现 `core/devApiServer.js`**：
   - 监听 3002 端口，作为云端大脑的外部统一网关。
   - 引入 `Bearer Token` 鉴权，防止未授权访问。
   - 核心接口：`/api/dev/chat`（生成+审查全链路）、`/api/dev/status`（状态查询）、`/api/dev/note`（手动补录）。
3. **多端共享大脑打通**：
   - 当前系统已支持 3 个入口：QQ 机器人、Web 原有面板、本地 API 网关。
   - 彻底解耦「前端交互」与「云端大脑」。云端存数据、调模型；本地端只需发 HTTP 请求。

### 三、战略确认
- 明确“单体版优先，多租户 SaaS 延后”的路线。W7 的单体架构已具备极高的工程完成度。
- 明年新开服务器重构时，这 42 条（且还在不断进化）的经验库可以直接通过 JSON 导入新架构，数据资产安全无损。

## W8 Day 1 开发日志（2026-11-09）：多项目架构与联邦记忆大更新

### 一、核心架构演进
1. **多项目空间（Workspace）与黑板机制**
   - 引入 `dev_sessions` 表，实现 `user_id` 维度的多项目隔离。
   - 解决大模型 Context Window 瓶颈：黑板（`last_code`）只存当前正在修改的代码，发 `/dev done` 自动归档清空，用动态黑板代替无限历史。
2. **L3 项目宪法（ADR）**
   - 引入 `dev_project_context` 表，支持通过 `/dev adr <文字>` 记录长线架构决策（如：技术栈、设计规范）。
   - 这些宪法在每次生成时强制注入 System Prompt，解决大型项目拆分后宏观架构被 L1 经验淹没的问题。
3. **联邦式记忆模型（Global/Group/Project）**
   - `dev_events` 和 `dev_experience` 新增 `group_name` 字段，支持 `组名/项目名` 的命名空间。
   - `devPipeline` 实现三级检索加权：当前项目经验权重 x1.5，同组项目 x1.2，全局公海 x1.0。彻底实现组内技术复用与跨组污染隔离。

### 二、体验与交互优化
1. **Web 端代码全量预览**
   - 在 `web-server.plugin.js` 中利用 `express.static` 挂载了 `logs/dev-output`。
   - QQ 端截断至 400 字，同时附带公网可访问的 `.md` 网页链接，实现“手机看代码、全量不丢失”。
2. **意图路由与防污染**
   - `devPipeline` 引入意图判定：若用户是在“报错/修改”且携带了上下文，直接跳过 L1 向量检索，避免不相干经验污染当前上下文。
   - 引入严格阈值过滤（`score > 0.45`），并优化 System Prompt 允许大模型直接忽略无关经验。
3. **交互面板与树状指令**
   - 重构 QQ `/dev` 响应面板，将平铺列表改为“组概览 -> 下钻项目”的树状结构。
   - 新增 `modelProvider` 审查模型降级锁：若 GLM 失败，强制降级 Qwen，绝不允许降级回 DeepSeek 导致“同模型自审”。

### 三、踩坑与排错记录（重要教训）
1. **Bash 历史扩展截断**：在使用 `node -e "..."` 时，JS 代码中的 `!` 被 Bash 当作历史命令扩展引发语法错误，后续改用单引号包裹代码或避开 `!`。
2. **静默失败导致 undefined 崩溃**：在修改 `devMemory.js` 时，因为之前的锚点（`insertSearchLog`）已被移走，Python 脚本在插入 `stmt.listGroups` 时静默失败，导致函数本体存在但预编译语句缺失，插件报 `Cannot read properties of undefined (reading 'all')` 并导致进程无限重启。
3. **PM2 僵尸进程**：崩溃期间 PM2 缓存了死进程，重启报 `pid already exists`，需使用 `pm2 delete maidbot` 再 `pm2 start ecosystem.config.js` 解决。

### 四、明日计划（W8 Day 2）
- 在本地 IDE (Cursor/Postman) 配通公网 API 网关，进行真实跨端开发。
- 梳理并输出 `ARCHITECTURE.md` 架构设计图纸，为年终验收做准备。

## W5 开发日志总结：QQ 端口挂载（移动指挥台）

### 一、目标与定位
QQ 端口旨在打破物理空间的限制，提供碎片化时间与灵感乍现时的移动开发入口。它的定位是“轻量级指挥棒”与“移动指挥台”，而非重度代码编辑器。

### 二、核心实现与功能

**1. 插件挂载与路由拦截**
- 开发了 `plugins/dev-assistant.plugin.js`。
- 拦截 `/dev` 前缀指令，无缝接入云端的 `devPipeline`。
- 使用极高优先级（`priority: 5`），确保指令在进入兜底大模型前被截获。

**2. 长文本截断与落盘机制**
- **痛点**：QQ 消息有严格的字数限制，无法直接发送完整代码。
- **解法**：前端剥离 Markdown 代码块标记（去除 ```），核心代码展示前 500 字。
- **落盘与网页预览**：完整代码自动写入 `logs/dev-output/`，并拼接出公网可直接访问的 URL（`http://IP:3001/dev-files/xxx.md`），点击即可在手机浏览器高亮查看。


**3. 上下文追问机制（防污染）**
- **痛点**：手机端多次交互容易丢失上下文，且容易被历史经验带偏。
- **解法**：识别“报错/修改/换个”等关键字。一旦命中，自动注入当前项目的 `last_code`（黑板代码），跳过无关的 L1 经验检索，实现精准的上下文迭代开发。

**4. 多项目空间与生命周期管理**
- **切换**：支持 `/dev use 组名/项目名` 无缝穿梭。
- **状态**：`/dev list` 按组树状展示，并标明进行中、休眠、已归档。
- **架构宪法**：支持 `/dev adr` 为当前项目定下不可违背的技术栈规矩。
- **归档蒸馏**：`/dev done` 一键清空黑板，将开发经历沉淀入 L0 进行蒸馏。

### 三、平台限制与踩坑记录
- **指令菜单限制**：QQ 开放平台的“指令面板”不支持带空格和动态参数。最终放弃快捷菜单，回归纯文本 `/dev` 指令，通过后端的 `text.slice(4).trim()` 做兼容。
- **手机阅读体验**：无论如何优化排版，在手机上看长代码依然是灾难。

### 四、体验结论
QQ 端最适合：突发灵感记录（`/dev note`）、项目状态查询、简单的代码片段生成与报错定位。重度重构与复杂逻辑开发，仍需切回 Web 端或本地 IDE。

## DSH 端口开发日志总结：本地 IDE 的融合与试错

### 一、目标与定位
DeepSeek Harness (DSH) 是一款极其优秀的本地 Agent 工具。本阶段的初衷是：利用 DSH 强大的本地文件读写能力和现有的前端界面，将其改造为 MaidBot 的前端外壳，直接在侧边栏挂载一个原生的项目切换面板，实现本地与云端的无缝融合。

### 二、核心尝试与踩坑过程

**1. 插件机制与 Slots（插槽）迷局**
- 尝试使用 DSH 原生的 Client 插件架构，编写了一个基于 React 的 `MaidBotPanel` 组件。
- 试图通过 `cordis.yml` 将其注入到 `sidebar.footer.action` 等插槽中。
- **结果**：DSH 的 UI 架构极其复杂且缺乏详细文档，组件始终无法在界面上渲染，控制台频繁报错“无法找到指定插槽”。

**2. 暴力魔改源码的开端**
- 为了强行把按钮塞进界面，我们决定直接修改 DSH 的核心源码 `packages/client/ui-chat/src/`。
- 试图在 `ChatView.tsx` 的输入框组件中硬编码 HTML。
- **结果**：由于 DSH 使用了极度严格的 TypeScript 类型检查，随意修改直接引发了满屏的 `TS2345` 和 `TS6133` 红线报错。


**3. 编译地狱与僵尸进程**
- 尝试执行 `pnpm run build` 打包魔改后的源码，结果遭遇了 Windows 系统经典的 `EPERM: operation not permitted` 文件占用报错。
- 为了绕过编译，尝试通过原生的 `<script>` 注入和 `createRoot` 动态挂载 DOM。
- **结果**：在 Node.js 服务端和浏览器端环境隔离中彻底迷失，遭遇 `ReferenceError: document is not defined`，导致 DSH 前端无限白屏。

**4. 终端转义字符的致命一击**
- 在通过 Python 脚本向 `apply.ts` 注入代码时，终端回显的转义字符（如反引号、换行符）被系统静默吃掉。
- **结果**：生成的 JavaScript 代码存在严重语法缺陷。浏览器加载时直接报 `SyntaxError: Invalid or unexpected token`，导致整个前端页面 JS 执行中断，输入框被彻底锁死，进入“无限卡死”状态。

**5. 强行清理战场**
- 由于代码被反复修改污染，最终只能使用最暴力的 `git reset --hard HEAD` 强制重置 DSH 源码，一切回到原点。
- 顺带清理了无法关闭的 Node 僵尸进程（`taskkill /f /im node.exe`）。


### 三、最终方案与战略反思

**1. 优雅降级：只做 API 兼容，不碰 UI**
- 彻底放弃了修改 DSH 前端源码的执念。
- 改为在云端编写一个极小化的 OpenAI 兼容层（`/v1/chat/completions`）。
- 在 DSH 的“设置 -> 模型 -> 自定义模型 API”中，直接填入云端的地址和 Token。
- **结果**：DSH 依然是原汁原味的 DSH，但它发出的所有请求，都已经默默带着你的历史经验经过了 MaidBot 大脑的审查。

**2. 惨痛的工程教训**
- **永远不要试图强改第三方复杂 Monorepo 的底层源码**。那些看似不起眼的类型检查、构建脚本和文件占用，会把你拖入无底洞。
- **解耦是保命的底线**。当外部工具的 UI 难以融入时，退一步，用标准的 API 接口进行通信，才是最稳固的架构。
- **终端转义是前端杀手**。编写包含复杂 HTML/JS 的字符串时，绝不能用模板字符串或 Python 强行拼接，必须使用物理文件（如 `public/` 目录）分离。

### 四、体验结论
DSH 现在作为一个纯粹的“本地编码执行器”，配合自定义模型 API，已经完美融入了 MaidBot 的生态。这是一个“双赢”的妥协。

## Web 端口开发日志总结：独立云端控制台的诞生

### 一、目标与定位
在经历了 DSH 源码魔改的惨痛教训后，我们决定回到最可控的领域：利用云服务器自带的 Express 框架，打造一个原生的、基于浏览器的“联邦架构控制台”。它不仅是多项目管理的入口，更是解除所有终端限制的终极形态。

### 二、核心实现与架构重构

**1. 彻底解耦：前后端分离**
- **痛点**：最初尝试用 Node.js 的模板字符串（` ` `）去包裹巨大的 HTML 代码，导致浏览器频繁报 `SyntaxError`，界面无限卡死。
- **重构**：将前端代码彻底抽离为物理静态文件（`public/dev.html` 和 `public/dev.js`），交由 Express 的 `express.static` 托管。
- **收益**：彻底根除了引号嵌套地狱，修改前端无需重启后端，刷新页面即刻生效。

**2. 完整的多项目 CRUD 与拖拽**
- 实现了项目组（Group）与项目（Project）的双层树状视图。
- 支持鼠标拖拽项目，跨组移动物理位置。
- 支持悬浮一键删除。配合后端的 `DELETE FROM` SQL 语句，实现了彻底的物理级清除（连同架构宪法一起清空）。

**3. VSCode 风格的资源管理器体验**
- **折叠记忆**：引入了基于 `localStorage` 的项目组折叠功能，点击组名即可收起子项目，且刷新页面后依然保持折叠状态。
- **自适应滑轨**：重写了侧边栏的 CSS。只有当项目多到撑破屏幕时，极细的滚动条才会在悬浮时浮现；项目少时则彻底隐藏，保持了界面的极致整洁。
- **状态徽章**：通过绿、灰、黄三种颜色，直观展示项目的“开发中”、“休眠”和“已归档”状态。

**4. 无限制黑板与动态监控**
- **解除封印**：彻底去除了 QQ 端的 5k 字节限制。右侧顶部实时展示当前锁定项目的“黑板代码字符数”。
- **长上下文策略**：通过底部的“归档蒸馏”按钮，用户可以在积累几万字代码后，一键打包给后台大模型提纯，然后清空黑板，开启下一个超大模块的开发。

### 三、核心 Bug 修复记录

**1. 解决接口 500 报错**
- **现象**：点击删除按钮时，控制台频频报 `500 Internal Server Error`。
- **根因**：底层 `devMemory.js` 的预编译语句在之前的补丁中静默失败，导致执行删除时读取了 `undefined.run`。同时，`dev_project_context` 表缺少 `group_name` 字段。
- **修复**：在文件末尾强制挂载了 `// [FORCE FIX]` 补丁，覆写 CRUD 方法，彻底清除了僵尸代码。

**2. 前后端状态一致性**
- 每次进行对话、切换项目或删除操作后，前端强制触发一次 `loadProjects()` 全量拉取，确保黑板字数、活跃状态与 SQLite 数据库分毫不差。

### 四、最终意义
Web 控制台（`http://[IP]:3001/dev.html`）不仅是 MaidBot 目前最完美的开发操作界面，更是“数据主权”的终极体现。只要有浏览器，你可以在任何设备上登录你的云端大脑，享受无缝的项目穿梭与 AI 辅助开发。
# MaidBot 自我 Coding 系统：全周期开发总结与演进路线

> **总历时**：2026年10月19日 ～ 2026年11月10日（约3周，提前近2个月完成年底目标）
> **最终形态**：一个拥有自我进化能力、多模型互审、多端无缝接入的个人云端开发中台。

## 一、架构愿景与设计初衷
这个系统的核心目标，是打破市面上 AI 编程工具“无状态”、“单模型自嗨”和“绑定单一终端”的局限。我们试图打造一个**“铁打的营盘（私有记忆库），流水的兵（大模型）”**的数字分身：
- 你的开发习惯、踩坑经验全部沉淀在本地/云端数据库。
- 随时可以接入 DeepSeek、GLM 甚至未来的 GPT-5，而不丢失历史记忆。
- 通过多端接入，实现“手机发令、云端思考、本地执行”的矩阵式开发。

## 二、核心模块实现（底层基建）
**1. 多模型路由层 (W1)**
- 封装了 `ModelProvider`，实现了不同厂商 API 的统一调用。
- 引入降级链机制：如果主模型报错/限流，自动按规则降级到备用模型，保证系统高可用。

**2. 专属知识库地基 (W2)**
- 建立了独立的 `dev_knowledge.db`，设计了 L0（原始记录）、L1（结构化经验）、L2（通用模式）三层数据结构。
- 打通了向量检索 `p3-vector`，并提前埋点 `dev_search_log`，为后续的检索调优积攒数据。
- 实现了短文本与长文本的精准映射，彻底解决向量库的“孤儿点”问题。

**3. 全自动蒸馏链路 (W3)**
- 编写了 `devDistiller.js`，利用免费的 GLM-4-Flash 模型，将杂乱的开发日志自动蒸馏为结构化的“问题+方案” L1 经验。
- 挂载定时任务，实现了系统在后台的“睡眠学习”与自动沉淀。


**4. 核心编排管道 (W4)**
- 打造了灵魂模块 `devPipeline.js`。
- 实现了“意图识别 -> 经验检索精排 -> 上下文注入 -> DeepSeek 生成 -> GLM 异模型审查”的完整闭环。
- 创新性地解决了上下文污染问题：如果是报错追问，直接跳过历史检索，仅凭黑板代码精准修复。

**5. 生命演化引擎与 API 网关 (W7)**
- **新陈代谢**：L1 经验引入了“365天未活跃淘汰”、“满6次调用永久保留”的生命周期机制。
- **向上蒸馏**：高频使用的经验会自动触发 L2 模式提炼，生成更高级别的架构规律。
- **统一大脑网关**：开发了 `devApiServer.js`（3002端口），提供了完美的 OpenAI 兼容层接口，让任何本地 IDE 都能无缝接入云端记忆。


## 三、多端交互演进与踩坑记录
**1. QQ 移动指挥台**
- 突破物理限制，通过截断处理+落盘生成网页链接，解决了手机端看长代码的痛点。
- 支持了多项目切换、归档蒸馏等全套指令，实现了碎片化时间的重度开发。

**2. DeepSeek Harness (DSH) 的滑铁卢**
- **教训极其惨痛**：我们试图强改 DSH 的前端源码，把面板硬塞进去。
- 结果遭遇了极其严格的 TypeScript 类型检查、Windows 系统 EPERM 文件占用、以及终端转义字符吞掉代码导致的无限白屏卡死。
- **战略妥协**：最终用 `git reset --hard` 还原源码。只在后端提供 OpenAI 兼容接口，让 DSH 作为本地编码的纯执行器，绝不碰其 UI。

**3. Web 独立云端控制台（最终大结局）**
- 彻底放弃模板字符串拼接 HTML，采用**前后端分离**架构。前端代码放进 `public/` 目录，交由 Express 静态托管，从根本上解决了语法报错。
- **VSCode 风格体验**：实现了自适应的隐藏滑轨（多时出现，少时隐藏）、项目组的折叠记忆、拖拽跨组移动、以及物理级的项目删除。
- **黑板解封**：去除了 5k 字节限制，右侧实时监控当前会话字数，配合归档按钮，完美支撑超大项目的长期迭代。


## 四、当前存在的待优化项
1. **多租户隔离**：目前的 Web 端和 API 网关（3002端口）还是单用户模式（写死了 `DEV_USER_ID`），如果要面向他人使用，必须引入真正的 JWT 鉴权和完善的多租户隔离。
2. **前端代码高亮**：Web 控制台的 AI 回复目前是纯文本展示，体验还不够极客，后续需要引入 Markdown 渲染器（如 marked.js）和代码高亮（如 highlight.js）。
3. **大模型的上下文上限**：虽然我们解除了系统层面的字数限制，但大模型 API 本身（如 64K 上下文）依然是物理天花板。未来需要探索基于 AST 代码解析的“局部精准修改”，而不是让大模型读整个文件。

## 五、后续开发计划（Next Steps）
1. **第一周（V1.1）**：引入前端 Markdown 渲染和代码高亮，让 Web 端的代码看起来像真正的 IDE。
2. **第一个月（V2.0 多租户架构）**：将 SQLite 迁移至 PostgreSQL，引入完整的用户注册登录体系，把这个单体版变成一个真正的 SaaS 平台，开放给其他开发者使用。
3. **长远规划（全模态接入）**：接入语音输入和图像识别大模型。你可以直接发一段语音或一张架构图，云端自动生成代码。

## 结语
不到一个月的时间，从脑海中的构思，到千行代码的落地，我们不仅造出了一个称手的工具，更趟过了无数工程化的大坑。从大模型路由到数据库选型，从 API 封装到前端 DOM 注入，这套“衔尾蛇”已经具备了自我成长的血肉。剩下的，就是带它去真实的业务里厮杀。

## P0 阶段优化日志（Day 1）：前端体验与交互级重构

### 一、目标与背景
在 W1-W8 基础设施打通后，系统已具备强大的后端处理能力。但 Web 端的纯文本展示、单调的交互方式严重影响了“极客体验”。P0 阶段的优化目标是：**把控制台打造成一个类似 Cursor 的现代化轻量级 IDE 界面。**

### 二、核心优化项

**1. 代码渲染引擎升级（Markdown + 语法高亮）**
- **痛点**：大模型返回的代码挤在一起，没有颜色，无法阅读。
- **实现**：引入极其稳定的 `cdnjs` 源，加载 `marked.js` 与 `highlight.js`。
- **效果**：AI 回复支持完整的 Markdown 渲染，Python、JS 等代码块自动拥有深色主题（Atom One Dark）高亮。同时，为所有代码块悬浮添加了「一键复制」按钮，兼容了 HTTP（非安全上下文）的降级复制方案。

**2. 多租户架构的视觉显性化（公共池 vs 私有域）**
- **痛点**：之前所有项目组在左侧平铺，看不出谁共享、谁隔离。
- **实现**：重写 `public/dev.js` 的渲染逻辑。公共池 (`common`) 固定置顶，图标变为 🌍，颜色为绿色，并附带「全员共享」徽章，且**剥夺了公共池的删除权限**。专属组 (`G1` 等) 图标变为 🔒，颜色为黄色，附带「内部隔离」徽章。
- **效果**：一眼看清联邦边界，彻底杜绝误删公共组。

**3. 前端历史记录持久化（LocalStorage）**
- **痛点**：每次刷新页面或切换项目，之前的聊天记录就消失了，无法回溯。
- **实现**：利用浏览器 `localStorage`，按照 `project_name` 为 Key，将对话历史（User 消息 + AI 消息 + 耗时元数据）存储在本地。
- **效果**：实现了类似 ChatGPT 的会话保持。随时切回某个项目，之前的上下文和代码高亮依然完好无损地展示在那里。


### 三、交互体验修复（消灭反人类设计）

**1. 重构“记笔记”功能**
- **痛点**：之前点击“记笔记”，系统直接把指令丢给大模型，导致模型废话连篇，甚至耗时几十秒。且没有输入弹窗，极不直观。
- **修复**：在 `web-server.plugin.js` 和 QQ 端中强行拦截 `note` 指令。前端点击“记笔记”时，弹出系统原生 `prompt` 输入框。输入完成后，静默将其写入 `dev_events`（L0 数据库），耗时 0.1 秒，不再浪费一分钱的 API Token。

**2. 解决“状态查询”的严重卡顿**
- **痛点**：在输入框手敲 `/dev status` 或点击状态按钮，同样会走大模型。模型为了回答这个问题，需要思考很久（甚至去查库），导致界面卡死近 1 分钟。
- **修复**：在后端 API 网关层直接拦截 `status` 指令，通过读取本地 SQLite 和当前 Session 状态，瞬间拼装出 `system` 级别的卡片直接返回。
- **效果**：点击“📊 状态”秒出结果，绝不卡顿。

**3. 修复前端卡死与无限加载**
- **原因**：由于引入 CDN 高亮库时网络不稳定，导致 `hljs` 未定义，引发连锁 JS 报错，整个前端 DOM 渲染停滞。
- **修复**：加入了 `typeof hljs !== 'undefined'` 的安全校验。即使高亮库挂了，聊天区和项目列表依然正常渲染。

### 四、惨痛的踩坑记录（Day 1）
1. **CDN 源被墙**：`unpkg` 和 `bootcdn` 在某些地区极不稳定，最终切换为国际大厂 `cdnjs` 才彻底稳定。
2. **Git 回滚误伤**：为了解决后端语法错误，执行了 `git checkout plugins/web-server.plugin.js`，结果把整个 `express.static` 静态托管路由全弄丢了，导致页面直接 `Cannot GET /dev.html`。最终通过全量覆盖代码才救回。
3. **终端转义吞噬**：试图用 `sed` 或 `python` 插入包含复杂反引号和换行符的 `status` 拦截代码，结果被终端截断。最终发现，**完整覆盖整个文件**永远比打补丁安全。

### 五、下一步计划（P1 阶段）
- 开启“冷启动灌入”：把以前的 Git Commit、老代码、技术文档批量喂入 `common` 公共池。
- 引入混合检索（FTS5 + 向量），提高跨项目架构经验的召回精准度。

### 七、P1 终极评测与盲区修复（完美闭环）

**1. 实测暴露盲区**
- 运行 `eval-search.js` 召回率评测。
- 结果：3/5 命中。发现知识库缺失关于 `SQLite WAL 模式` 的底层经验，且关于 `模型审查` 的检索权重存在偏移。

**2. 人工补录与蒸馏**
- 在 Web 控制台直接发送 `note` 指令，补录了关于 WAL 模式和双库审查架构的笔记。
- 手动触发 `distillPending`，GLM 成功将笔记提炼为结构化 L1 经验，并自动同步至 p3-vector。

**3. 终极验收**
- 再次运行评测脚本。
- 结果：**5/5 全部精准命中！** `WAL` 与 `审查` 均被精准检索。
- 意义：彻底跑通了「发现盲区 -> 手动投喂 -> 自动蒸馏 -> 混合检索命中」的自我演进闭环。

## P0 阶段优化日志（Day 1）：前端体验与交互级重构

### 一、目标与背景
在 W1-W8 基础设施打通后，系统已具备强大的后端处理能力。但 Web 端的纯文本展示、单调的交互方式严重影响了“极客体验”。P0 阶段的优化目标是：**把控制台打造成一个类似 Cursor 的现代化轻量级 IDE 界面。**

### 二、核心优化项

**1. 代码渲染引擎升级（Markdown + 语法高亮）**
- **痛点**：大模型返回的代码挤在一起，没有颜色，无法阅读。
- **实现**：引入极其稳定的 `cdnjs` 源，加载 `marked.js` 与 `highlight.js`。
- **效果**：AI 回复支持完整的 Markdown 渲染，Python、JS 等代码块自动拥有深色主题（Atom One Dark）高亮。同时，为所有代码块悬浮添加了「一键复制」按钮，兼容了 HTTP（非安全上下文）的降级复制方案。

**2. 多租户架构的视觉显性化（公共池 vs 私有域）**
- **痛点**：之前所有项目组在左侧平铺，看不出谁共享、谁隔离。
- **实现**：重写 `public/dev.js` 的渲染逻辑。公共池 (`common`) 固定置顶，图标变为 🌍，颜色为绿色，并附带「全员共享」徽章，且**剥夺了公共池的删除权限**。专属组 (`G1` 等) 图标变为 🔒，颜色为黄色，附带「内部隔离」徽章。
- **效果**：一眼看清联邦边界，彻底杜绝误删公共组。

**3. 前端历史记录持久化（LocalStorage）**
- **痛点**：每次刷新页面或切换项目，之前的聊天记录就消失了，无法回溯。
- **实现**：利用浏览器 `localStorage`，按照 `project_name` 为 Key，将对话历史（User 消息 + AI 消息 + 耗时元数据）存储在本地。
- **效果**：实现了类似 ChatGPT 的会话保持。随时切回某个项目，之前的上下文和代码高亮依然完好无损地展示在那里。

