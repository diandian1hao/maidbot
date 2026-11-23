# Phase 1 开发日志：宪法护栏与状态快照

| 项 | 内容 |
| :--- | :--- |
| 项目 | MaidBot / Ouroboros（衔尾蛇） |
| 阶段 | Phase 1 — 状态机与宪法护栏 |
| 状态 | 后端闭环、前端可用，待办见第六节 |
| 日期 | 2026-11-23 |
| 环境 | Ubuntu · Node 20.20.2 · better-sqlite3 · PM2 |

## 一、阶段目标

1. 建表 `dev_snapshot`（状态快照）/ `dev_constitution_history`（宪法历史）
2. `devPipeline.js` 的 Prompt 组装强制注入「宪法 + 状态快照」
3. 提供宪法读写 API，且每次修改必须留痕
4. 对话结束后自动写快照，替代「只靠 LIMIT 聊天记录」的旧上下文机制

## 二、完成清单

| 编号 | 内容 | 结果 |
| :--- | :--- | :--- |
| 1 | 两张表建立 | 完成，列结构与设计逐字一致 |
| 2 | P1：读快照并注入 sysPrompt | 完成 |
| 3 | P2：`GET/POST /api/dev/constitution` | 完成，返回 200 |
| 4 | P3：对话后写 `dev_snapshot` | 完成，已有实测数据 |
| 5 | 宪法变更留痕（old/new/reason） | 完成，可审计 |
| 6 | 宪法对模型的实际约束 | 已验证，模型主动复述并执行三条 |
| 7 | 前端面板（外挂 constitution-panel.js） | 完成，含 ①② 分区与实时字数 |
| 8 | 空宪法警示 | 完成，按钮变「⚠️ 宪法未设置」 |

## 三、验收命令（可复现）

```bash
cd ~/maidbot && node -c core/devPipeline.js && node -c plugins/web-server.plugin.js
node -e "const db=require('better-sqlite3')('dev_knowledge.db');console.log(db.prepare('PRAGMA table_info(dev_snapshot)').all().map(c=>c.name).join(','))"
curl -s http://127.0.0.1:3001/api/dev/constitution
node -e "const db=require('better-sqlite3')('dev_knowledge.db');console.log(db.prepare('SELECT * FROM dev_snapshot').all())"
```

实测结论：

- 表结构为 `user_id,group_name,project_name,snapshot_json,updated_at`
- 宪法 GET 返回 `success:true`，项目 `common/node-tool`
- 宪法 POST 后历史记 `old_len=63 / new_len=84`，前后差异可审计
- `dev_snapshot` 有一行，含 `lastQuery` 与 `lastReplySummary`，对话后自动轮转成立

## 四、过程复盘：三个问题

**1. curl 完全无输出**：最初误判为路由未注册，实际是 PM2 处于 stop 状态，连接被拒且 `curl -s` 静默吞错。
教训：空输出不能当作「接口不存在」的证据，必须先看 `ss -lntp` 与 `pm2 list`。

**2. 宪法「改了没更新」**：连续两次保存后 `old_len == new_len`，内容未变。查 `change_reason` 才发现输入落在了「修改原因」框，正文文本框一直没动。
处理：面板加 ①② 编号分区、原因框缩窄 62%、底部实时显示「服务器 N 字 / 输入 M 字」。
教训：两个同色输入框并排，必须用编号与宽度做视觉分级，不能只靠 placeholder。

**3. 空宪法静默失效**：`constitution` 为空串时 `if (ctx)` 直接跳过注入，护栏等于不存在且无提示。
处理：面板按返回值把按钮切成「⚠️ 宪法未设置」；待办是在对话侧补一条 warn 日志。

## 五、当前数据现状

| 表 | 状态 |
| :--- | :--- |
| `dev_project_context` | `common/node-tool` 有 5 条宪法；`common/blog-app` 一条旧格式文本 |
| `dev_constitution_history` | 6 条记录，含 3 条空改动（操作失误样本，保留作审计对照） |
| `dev_snapshot` | `common/node-tool` 一行，字段为 `lastQuery` + `lastReplySummary` |

当前生效宪法（`common/node-tool`）：

```
1. 只使用 Node.js 内置模块，禁止引入第三方依赖。
2. 所有新增代码必须带中文注释。
3. 改动任何文件前先备份。
4. 所有新模块必须先写 README。
5. 所有对外接口必须写单元测试。
```

## 六、遗留问题与风险

| 优先级 | 事项 | 说明 |
| :--- | :--- | :--- |
| P0 | 3001 公网开放且无鉴权 | 任何能连上的人都能改宪法，等于能改 system prompt |
| P1 | 快照字段仍是占位符 | 未结构化，且 `lastReplySummary` 带着 Markdown 符号 |
| P2 | 「AI 无写权限」只是约定 | 代码层没有拦截，属 Phase 4 RBAC 范围 |
| P3 | 备份文件堆积 | `public/*.bak_*` 需定期清理，只留最近两份 |

## 七、决策记录（ADR）

- **ADR-01** 宪法按项目维度存储，存 `dev_project_context.context_md`，随 active session 切换。
- **ADR-02** 宪法变更必须留痕，写入 `dev_constitution_history`，保留 `old_text/new_text/change_reason`，使「改没改」成为可查证事实。
- **ADR-03** 前端外挂而非内联：面板独立为 `public/constitution-panel.js`，`dev.html` 只加一行 script，便于回滚且避免大文件粘贴截断。
- **ADR-04** 状态快照替代对话流：上下文 = 宪法 + 快照 + 近几轮摘要，不再依赖 `LIMIT N`。

## 八、下一步：Phase 2 入口

只改 `plugins/web-server.plugin.js` 中 P3 的写入逻辑，把 `snapshot_json` 升级为结构化：

```json
{
  "current_task": "本轮开发目标（截断 120 字）",
  "file_tree": ["utils/date.js", "README.md"],
  "last_diff": "本轮产出代码块 / 本轮为说明",
  "recent_summary": "剥掉 Markdown 标记的语义摘要（160 字）",
  "updated_at": 1795442684736
}
```

验收标准：发一轮对话后 `file_tree` 能准确列出涉及文件，且 `recent_summary` 不含 `#`、`**`、反引号等标记。

---

*本日志所有结论均可用第三节命令复现。*

## 九、安全加固（2026-11-23 追加）

- 3001 增加 Token 门禁：仅保护 `dev.html` / `dev.js` / `constitution-panel.js` / `dev-files` / `api/dev/*`，公开聊天接口 `/` 与 `/api/chat` 保持开放
- Token 由环境变量 `WEB_TOKEN` 注入；浏览器首次带 `?k=` 访问后写入 HttpOnly Cookie（一年有效），脚本调用使用 `x-dev-token` 请求头
- 8000（矢量库）与 9090（Prometheus）防火墙来源改为 `127.0.0.1`，不再对公网暴露
- 3000（Grafana）依赖自身登录体系：强密码 + 关闭匿名访问与注册
- 已记录的新风险：`WEB_TOKEN` 未配置时中间件放行（fail-open），依赖 `pm2 save` 持久化；后续应改为 fail-closed
- 已记录的新风险：`trust proxy=1` + `req.ip` 可被 `X-Forwarded-For` 伪造，绕过每日限流

## 十、Phase 2：状态快照与经验审计（2026-11-23）

### 10.1 快照结构化

`snapshot_json` 由 `{lastQuery, lastReplySummary}` 升级为：

```json
{ "current_task": "...", "file_tree": ["core/slug.js"], "last_diff": "产出代码块约 42 行", "recent_summary": "...", "updated_at": 1795448587292 }
```

三个实现要点：

- 文件树正则加负向断言 `(?<![\w\-\/.])`，修掉 `test/str.test.js` 被截成 `test.js` 的部分匹配
- 噪音黑名单过滤 `node.js` / `vue.js` / `react.js` 等库名，避免正文提到的框架被当成文件
- 摘要清洗：剥代码围栏、去 `#*>` 与反引号、压缩空白、修正标点前的空格

### 10.2 注入方式

不再塞裸 JSON，改为人类可读的结构化段落，并带新鲜度：

```
【当前项目状态快照（以此为准）】
- 当前任务：给 core/slug.js 的 separator 加转义
- 涉及文件：core/slug.js, core/README.md
- 上轮产出：产出代码块约 42 行
- 快照时间：3 分钟前
```

行为验证：提问「项目做到哪一步」，模型回答「根据快照，正处在给 core/slug.js 增加自定义分隔符参数这个任务上」，并列出对应步骤。

### 10.3 事件触发蒸馏

- 触发条件：本轮回复含代码围栏，无代码产出不蒸馏
- 触发时机：响应结束后延迟 3 秒，避开 L0 事件写入的竞态
- 并发保护：进程内互斥锁；限流：同一项目每小时最多 3 次
- 质量门：蒸馏前再判一次代码围栏，无代码的 L0 标 `unstructured` 跳过
- 指纹：`code_hash` = 产出正文 sha1 前 12 位

实测链路：`23:58:53 快照注入` → `23:59:28 事件触发` → `23:59:34 蒸馏完成 {"success":1}`

### 10.4 审计发现：432 条历史经验不可用

- 432 条 `pending` 实为 `ALTER TABLE ... DEFAULT 'pending'` 给历史行盖的默认值，并非解析失败
- 11-18 之后再无一条 `rejected`，说明审核自该日起开始静默失效（返回非 JSON 时状态停在初始值）
- 用严格口径（技术实体 + 可复现条件 + 可执行动作，三条缺一即驳回）随机抽样 30 条：**通过 0 条**
- 人工核验驳回样本，内容确为「完成 XX 功能」「实现 XX 能力」式流水账，无文件、无报错、无做法
- 结论：历史 L1 记录的是变更摘要，不是可复用经验

处置：批量标记 `rejected`（`is_permanent=1` 不动、数据不删除、可回滚），L1 可用池由 461 条收缩到 8 条。
依据：检索时 5 条召回里若有 4 条是废话，会挤占上下文并误导模型，**8 条真实经验优于 432 条流水账**。
另：同一批数据两次运行结论翻转（#437 一次 passed 一次 rejected），已将质检温度由 0.1 改为 0，空理由视为无效判定。

### 10.5 本阶段遗留

- `kind` 字段（`code_experience` / `methodology` / `noise`）尚未引入，老数据中确有架构讨论属 L2 原料，留待 Phase 3
- 2 条 `is_permanent=1` 的未审记录未纳入本次处置，需单独确认
- 审核器依赖 `glm-4-flash`，若驳回率异常偏高或偏低，需换模型复测
