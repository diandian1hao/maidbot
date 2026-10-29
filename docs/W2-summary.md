# MaidBot 自我 Coding · W2 开发总结

> **周期**：2026-10-26 ～ 10-29  
> **主题**：知识库地基（dev_knowledge.db + L0/L1 数据层 + 向量同步 + 埋点）  
> **结果**：原计划 11/01 完成，实际 10/29 完成，**提前 3 天**  
> **提交**：10+ commits，全部 push 到 origin/main  

---

## 一、目标与完成情况

| 里程碑 | 原计划 | 实际完成 | 偏差 |
|--------|--------|---------|------|
| M1 建表（4 表 10 索引） | 10/27 | 10/26 | 提前 1 天 |
| M2 L0 层（9 方法） | 10/28 | 10/26 | 提前 2 天 |
| M3 L1 层（5 方法） | 10/28 | 10/27 | 提前 1 天 |
| M3.5 搜索埋点（计划外） | — | 10/27 | 额外完成 |
| M4 向量同步 | 10/29 | 10/27 | 提前 2 天 |
| M5 端到端测试 | 10/30 | 10/28 | 提前 2 天 |
| M6 冷启动灌入 17 条 L0 | 11/01 | 10/28 | 提前 4 天 |
| M6 复盘 + 数据清理 | 11/01 | 10/29 | 提前 3 天 |

**W2 完成度：100%。**

---

## 二、交付物清单

### 2.1 代码文件（8 个）

| 文件 | 职责 |
|------|------|
| core/devMemory.js | L0 9 方法 + L1 5 方法 + 向量同步 + 异步检索 + 埋点 |
| scripts/init-dev-knowledge.js | 4 表 10 索引初始化 + 自检 |
| scripts/backup_db.js | 三库（chat/maid/dev）6h 定时备份 |
| scripts/bootstrap-dev-knowledge.js | 冷启动：扫 README/CHANGELOG/ops-log 切段写 L0 |
| scripts/test-dev-memory-l0.js | L0 层 5 项测试 |
| scripts/test-dev-memory-l1.js | L1 层 7 项测试（async 版） |
| scripts/test-dev-knowledge-vector.js | 向量同步 5 项测试 |
| scripts/test-dev-knowledge-e2e.js | 端到端 9 步全链路测试 |

### 2.2 数据库结构与状态

    dev_knowledge.db
    ├── dev_events        L0 原始事件（12 字段，3 索引）
    ├── dev_experience    L1 结构化经验（13 字段 + 外键，4 索引）
    ├── dev_patterns      L2 模式归纳（6 字段，W6 启用）
    └── dev_search_log    搜索埋点（12 字段，3 索引）

| 表 | 行数 | 说明 |
|----|------|------|
| dev_events | 17 | README 11 + CHANGELOG 1 + ops-log 5，待蒸馏 |
| dev_experience | 0 | W3 蒸馏后填充 |
| dev_patterns | 0 | W6 启用 |
| dev_search_log | 25 | 测试期间积累的埋点数据 |
| p3-vector（dev_me） | 0 | 孤儿点已清干净 |

---

## 三、架构设计决策

### 3.1 三库独立，零耦合

    chat_memory.db    用户对话记忆（W1 前已有）
    maid_memory.db    长期记忆摘要（W1 前已有）
    dev_knowledge.db  开发知识库（W2 新建）

**理由**：聊天记忆含大量闲聊和情绪化表达，混入开发检索会严重干扰。独立后清空开发库不影响聊天记忆。

### 3.2 向量隔离：约定优于改动

利用 p3-vector 原生支持的 memory_type 过滤，**零改动 p3-vector 代码**：

| 字段 | 值 | 作用 |
|------|-----|------|
| user_id | 'dev_me' | 与真实用户 openid 天然隔离 |
| memory_type | 'dev_experience' | 与 'short'/'long' 对话记忆隔离 |
| point_id | 1_000_000_000 + L1.id | 整数偏移，与 chat_memory 整数 id 不撞车 |

**反查**：results[i].id - 1e9 = L1.id。

### 3.3 searchExperience 改为异步

**原因**：向量检索本质是异步 HTTP 调用。**早改早省事**——W4/W5 还没写，现在改成本最低。
- 旧（SQLite fallback）：`const hits = dm.searchExperience(query, opts);`
- 新（向量+降级）：`const hits = await dm.searchExperience(query, opts);`

### 3.4 埋点前置与降级链

- **埋点前置**：W2 就建 dev_search_log 表。成本 15 分钟，收益是 W2–W6 搜索行为全被记录，W7 有米下锅。
- **降级链**：路由层（provider 失败切换） / 检索层（向量失败退 SQLite） / 蒸馏层（JSON 失败打 unstructured 标记）。

---

## 四、关键技术实现

### 4.1 searchExperience 的核心逻辑

    1. 若指定 taskType → 向量检索 top_k 放大 3 倍
    2. 调 p3-vector /search
    3. 对每个 result：
       - 反查 L1（id - 1e9）
       - 若 L1 不存在 → 过滤（孤儿点）
       - 若 taskType 不匹配 → 过滤
    4. 截断到 topK
    5. 若向量检索抛异常 → 降级 SQLite fallback
    6. 记录埋点（query/hit_count/top_score/latency）

**关键设计**：孤儿点过滤和 taskType 过滤**都发生在向量库返回之后**，所以 top_k * 3 是必要的冗余。

### 4.2 冷启动切段策略

    按 ## 标题切段
      → 过滤段长 < 80 字（太碎）
      → 过滤段长 > 2000 字（太长）
      → 上限 20 段（MAX_SEGMENTS）

**实际效果**：README 11 段 + CHANGELOG 1 段 + ops-log 5 段 = 17 段。切出的是结构化知识段落，适合蒸馏。

---

## 五、测试覆盖与踩坑教训

### 5.1 测试套件（26 项全绿）

| 测试套件 | 项数 | 覆盖范围 |
|---------|------|---------|
| test-dev-memory-l0.js | 5 | 写入/读取/标记/降级/采纳 |
| test-dev-memory-l1.js | 7 | 写入/读取/状态/采纳/检索/外键/校验 |
| test-dev-knowledge-vector.js | 5 | 同步/检索命中/埋点/过滤/降级 |
| test-dev-knowledge-e2e.js | 9 | 全链路闭环 |

### 5.2 新增踩坑（累计 13 条）

| # | 坑 | 教训 |
|---|-----|------|
| 10 | /tmp 下 require('axios') 失败 | Node 20 自带 fetch，探测脚本用 fetch |
| 11 | 冷启动灌入后测试 FAIL | 测试的 limit 给足余量（10→100） |
| 12 | point_id 字符串报 422 | p3-vector 必须整数，用 1e9 偏移 |
| 13 | 测试残留 L0 + 孤儿向量 | 清理逻辑放 finally，确保必执行 |

### 5.3 反思：做对了什么 vs 可以更好

**做对了**：
1. 探测先行（30 分钟探测 4 个未知数，省了 2 小时返工）
2. 埋点前置（成本低，价值贯穿后续 5 周）
3. 两段式写入（>30 行脚本先写 /tmp 再 cp）

**可以更好**：
1. 坑 13 本可避免，以后 W3 测试必须用 finally
2. top_k * 3 目前是拍脑袋，W4 接入需按实际召回率调整

---

## 六、系统全景与下一步

### 6.1 架构层次图（W2 后）

    ┌──────────────────────────────────────────────┐
    │  入口层（W5）    QQ /dev 指令 / Web            │  未开始
    ├──────────────────────────────────────────────┤
    │  编排层（W4）    devPipeline 共享管道          │  未开始
    ├──────────────────────────────────────────────┤
    │  蒸馏层（W3）    devWorker.distillPending      │  下一步
    ├──────────────────────────────────────────────┤
    │  数据层（W2）    dev_knowledge.db              │  100% 完成
    │    L0 17条 / L1 就绪 / 埋点运行 / 向量已接通   │
    ├──────────────────────────────────────────────┤
    │  路由层（W1）    ModelProvider                 │  已可用
    ├──────────────────────────────────────────────┤
    │  基础层（已有）  PM2 / WAL / 探针 / 三库备份    │  就绪
    └──────────────────────────────────────────────┘

### 6.2 对 W3 的输入

**原料**：17 条 L0（README 11 + CHANGELOG 1 + ops-log 5）。

**Worker 处理流**：
    getUndistilled(20)
      → modelProvider.route('distill', prompt)   // GLM-4-Flash 免费
      → JSON 校验
        ├── 成功 → writeExperience → sync向量 → markDistilled
        └── 失败 → markUnstructured (finally 清理)

**W3 预估耗时**：2.5 小时。基础设施全通，只写“L0转L1”的胶水逻辑。

---

## 七、一句话总结

W2 用 3 天完成了原计划 7 天的数据层建设，核心是「探测先行 + 埋点前置 + 降级兜底 + 两段式写入」。17 条 L0 已就位，W3 的蒸馏链路有了完整的地基。
