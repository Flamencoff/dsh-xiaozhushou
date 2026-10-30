# 架构与模块边界

> 版本基线：0.47.0。本文件只写**边界与规则**，不写开发流水账；决策原因写进最后一节。
> 目标：一个模块可以**单独改、单独测、单独回退**，不牵连其它功能；最终形态按 DSH「一切皆插件」收敛为可独立启停的 bundle 行。

## 一、现状（0.47.0）

```text
DSH Host
 └── cordis.patch.yml 插入 1 行插件：id=steward, name=dsh-xiaozhushou
      └── index.js（宿主半，1215 行）
           ├── 注册 27 条 HTTP 路由（/api/dsh-xiaozhushou/*，本机 127.0.0.1 回环接口，不是对外网关）
           ├── 注册 3 个工具（steward_secretary / steward_ceo / steward_historian）
           ├── 注册 3 个角色 preset + 60s 心跳
           └── 组装 core/ 39 个模块
      └── client.js（客户端半，看板/浮窗）
           └── 注册 3 个插槽：sidebar.panellist / main / shell.overlay
```

### 模块清单

| 模块 | 职责 | 对外契约 | 测试 |
|---|---|---|---|
| `core/paths.js` | 数据目录解析与指针 | `resolveDataDir` / `readPointer` / `writePointer` | harness |
| `core/config.js` | 配置默认值、校验、收敛 | `DEFAULT_CONFIG` / `resolveConfig` | harness |
| `core/store.js` | JSON 文件读写、原子写、坏数据降级 | `createStore(dataDir)` | harness |
| `core/audit.js` | 审计 JSONL | `createAudit` | harness |
| `core/ledger.js` | 待办台账状态机、每周归档 | `createLedger(store)` | harness |
| `core/priority.js` | 优先级四象限计算 | `computePriority` | harness |
| `core/inbox.js` | 收件箱（append-only） | `createInbox(store)` | harness |
| `core/alarm.js` | 三定点提醒、静默、闸门、去重 | `createAlarm({...})` / `inQuietHours` | harness |
| `core/push.js` / `notify.js` | 沙盒推送 / 桌面通知 | `createPush` / `createNotifier` | harness |
| `core/collect.js` | 会话元数据采集（不读内容） | `collect(ctx)` | harness |
| `core/board.js` | 看板数据组装 | `buildBoard` / `buildState` | harness |
| `core/session-source.js` | 会话来源适配（live/persisted） | `createSessionSource` | harness |
| `core/cursor.js` / `read.js` | 史官游标、事件筛选 | `createCursor` / `selectEvents` | harness |
| `core/historian.js` | 史官：读会话 → 言行录；跑完触发记忆周更 | `createHistorian`（可注入 `memory`） | harness |
| `core/handover.js` | 交接卡（短卡 + 底账） | `createHandover` | harness |
| `core/memory.js` | 长期记忆四文件：ensure / 周更 / 摘要 | `createMemory`（`ensure` / `maybeWeeklyUpdate` / `summaryFor`） | harness |
| `core/role-chat.js` | 三角色聊天：只走绑定会话（失败显式报错，无模型兜底）；绑定点记 seq，只回最新一条回复 | `createRoleChat`（含 `bind`） | harness |
| `core/brain.js` | 模型调用封装 | `createBrain` | harness |
| `core/tools.js` | 三个角色工具 | `createToolset` / `runCeoAnalysis` | harness |
| `core/escalate.js` | 判断类问题升级 CEO | `shouldWakeModel` | harness |
| `core/find.js` | 白名单找文件（默认不搜内容） | `createFinder` | harness |
| `core/repair.js` | 维修站诊断文本 | `writeRepairStation` | harness |
| `core/limits.js` / `spawn.js` | 限额、会话派生 | `createSpawner` | harness |
| `core/ceo-execute.js` | CEO 硬动作：识别"开新会话执行"→ 真建 CEO 预设会话 | `detectExecuteIntent` / `createCeoExecutor` | harness |
| `roles/index.js` | 角色身份提示 + 工具面收窄 | `apply(ctx, {role})` | harness |
| `roles/presets.js` | 三个 preset 声明 | `presetDefinitions` | harness |
| `client.js` | 看板 / 浮窗 / 聊天窗 UI | 3 个插槽 | harness（vm 校验） |

## 二、依赖规则（`scripts/check-imports.mjs` 强制）

1. **单向**：`index.js` → `core/`、`roles/`；`core/` 不得 import 入口、客户端或 `roles/`；
2. **零外部依赖**：宿主半只允许 `node:` 内置模块；客户端半只允许宿主提供的 `react`；
3. **无循环依赖**：模块之间只能通过函数参数 / 返回值协作，不许互相 import 成环；
4. **不偷全局**：core 模块只接收显式传入的依赖（`store`、`config`、`dataDir`、`log`…），不读 `process.cwd()`、不写隐藏单例；
5. **叶子模块**（`paths` / `store` / `config` / `audit` / `limits`）不得依赖业务模块。

## 三、公共契约（改这些 = 跨模块变更，必须单开分支）

| 契约 | 当前值 | 兼容要求 |
|---|---|---|
| HTTP 路由（27 条） | 全部注册在 DSH **本机 Web 服务**上（`http://127.0.0.1:<端口>/api/dsh-xiaozhushou/*`） | **回环接口**，不另开端口、不监听 0.0.0.0、不做对外网关；改前缀必须同步 `client.js` + 文档 + 测试 |
| 工具名 | `steward_secretary` / `steward_ceo` / `steward_historian` | 模型已在使用，改名要留别名 |
| preset id | `steward-secretary` / `steward-ceo` / `steward-historian` | 旧会话可能引用，改名要迁移 |
| 数据文件 | `待办.json`、`任务.json`、`审计.jsonl`、`采集.json`、`看板.json`、`状态.json`、`提醒状态.json`、`推送状态.json`、`归档状态.json` | 字段只增不删；删字段必须写迁移 |
| 史官产物 | `<数据目录上级>/史官/言行录/YYYY-MM/YYYY-MM-DD.md` | 追加写，不改旧内容 |
| 角色对话 | `<数据目录>/<角色>/对话/<日期>.md`、`<角色>/回复/*.md` | 同上 |
| 长期记忆 | `<数据目录>/记忆/{用户画像,近期交代,长期规划,情绪与处境}.md` + `记忆/状态.json` | 周更只重写 `<!-- AUTO:START -->…<!-- AUTO:END -->` 自动区，区外手写内容不覆盖；四文件名固定；内容来源仅限台账/任务板、`<角色>/对话/*.md`、`史官/言行录`（插件自己写的本地文件），不直接读宿主原始会话正文 |
| CEO 执行入口 | `POST /ceo/chat` 命中"开新会话执行 …" → create(`steward-ceo`) + rename(`dsh小助手 · CEO 执行`) + prompt(任务) | 与按钮开会话共用 4 次/小时限频；失败回 502 显式错误，不静默 |
| 配置 | `cordis.patch.yml` 的 `config`（见 README 配置表） | 新键给默认值，旧键不删 |

## 四、目标形态：拆成可独立启停的 bundle 行

最终 `cordis.patch.yml` 从「1 行大插件」变成「1 个组合包 + 多行插件」，每行可单独 `disabled`：

| 目标行 | 承接现在的 | 说明 |
|---|---|---|
| `steward-core` | paths / store / config / audit / limits | 提供服务；其余行 `inject` 它 |
| `steward-ledger` | ledger / priority / inbox | 台账与收件箱；不碰 UI |
| `steward-reminder` | alarm / push / notify | 提醒与推送；依赖 ledger |
| `steward-board` | collect / board / refresh | 看板数据；依赖 ledger + reminder |
| `steward-historian` | cursor / read / historian | 史官；依赖 core + session |
| `steward-roles` | role-chat / tools / presets / handover / session-source | 三角色聊天与任务板；依赖 core + ledger |
| `steward-pet` | client.js 的浮窗部分 | 可单独关掉看板娘 |
| `steward-client` | client.js 的看板部分 | 目前客户端半按「一个包一个 client 入口」注册，拆分需确认宿主是否支持多入口；不支持时先做内部模块化 |

**拆行原则**：
- 每行有独立 `apply`，只注册自己的路由 / 工具 / 插槽；
- 行与行之间只通过 **Cordis 服务**（`ctx.get` / `Service`）或**磁盘文件**协作，不互相 import 实现细节；
- 拆一行 = 一个 `refactor/<row>` 分支，先补测试再动代码，合入后 main 必须仍能启动。

## 五、落地路线（按分支推进，每步可回退）

| 阶段 | 分支 | 验收标准 |
|---|---|---|
| P1 基础设施 | `refactor/core-services` | 抽出 core 服务接口；harness 全绿；`check-imports` 无新告警 |
| P2 提醒 / 台账拆行 | `refactor/ledger-reminder-rows` | 两行可单独 `disabled`，关掉后其余功能正常；接口冒烟通过 |
| P3 史官 / 角色拆行 | `refactor/historian-roles-rows` | 同上；角色工具面不串 |
| P4 客户端模块化 | `refactor/client-modules` | 看板与浮窗可分别关闭；UI 手工验收清单过 |

> P1–P4 的模块边界以作者的设计框架文档为准；框架定稿前不合并任何拆行改动。

## 六、发布门槛 v2（2026-10-26 作者拍板；0.47.0 **已全部落地**）

> 来源：旧仓库 `54_框架偏差确认表 v2`、`53` 的 T8 专项、`55` 第十节。
> 结论：v0.46.0 只是"发布工程基线"；以下 7 条已在 0.47.0 全部落地（每条一个分支 + 合并），可作发布版。

| # | 门槛 | 现状 | 落地分支 |
|---|---|---|---|
| D-01 | 聊天**必须进真实会话**；删掉"直连模型兜底"，会话不可用时报错（说出卡在哪） | 已完成（0.47.0：聊天失败回 409/502/503/504，无模型兜底） | `feat/force-session-chat` |
| D-02 | 全库去角色口癖式表述，统一叫「智能助理」；UI / prompt / 文档一致 | 已完成（0.47.0，含全库守卫用例） | `refactor/neutral-persona` |
| D-05/06 | 史官门控：发布版默认 `enabled.historian: true` + `scope.mode: all`（可读真实会话）；开发测试版 `sandbox`（只读 `[实验]`） | 已完成（0.47.0：patch/默认值都是 true + all；sandbox 配法写进 README） | `feat/historian-gating` |
| D-18 | 数据目录默认 `%USERPROFILE%\.dsh-session-steward\data`，兼容旧指针迁移 | 已完成（0.47.0：新指针优先，旧 `.dsh-xiaozhushou` 指针回退读取） | `fix/datadir-name` |
| D-19 | 长期记忆简化版：四文件（用户画像 / 近期交代 / 长期规划 / 情绪与处境），史官周更，秘书/CEO 按需读 | 已完成（0.47.0：`core/memory.js` + 摘要 ≤420 字进上下文） | `feat/memory-files` |
| D-20 | CEO：判断后会话/工具式硬动作；用户说"开新会话执行"→ 真开会话并跑通权限审批 | 已完成（0.47.0：接下/完成/转交 + `core/ceo-execute.js`） | `feat/ceo-execute` |
| D-16 | 发布说明写清"27 条路由 = 本地回环接口"，不是对外网关 | 已完成（0.47.0：README/RELEASE/ARCHITECTURE 三处 + 守卫用例） | `docs/route-note` |

**执行顺序**：D-18 → D-02 → D-01 → D-05/06 → D-16 → D-19 → D-20。
每条分支的验收 = `node test/harness.mjs` + 发布自检 + 依赖体检 + `53` 的 T8 对应专项；
**一个分支只做一条**，通过后 `merge --no-ff`，全部完成再切 `release/0.47.0` 打 tag。

## 七、决策记录

| # | 决策 | 原因 |
|---|---|---|
| D1 | 0.46.0 先以「单行插件」发布，不阻塞上线 | 现有代码已 145 项自测 + 真机验证；先拿发布基线，再按分支拆 |
| D2 | 模块间以磁盘 JSON / Markdown 为稳定契约 | 用户可直接看、可备份；拆行时数据不用迁移 |
| D3 | 路由统一前缀 `/api/dsh-xiaozhushou` | 避免与其它插件撞路径；客户端与宿主同源直连 |
| D4 | 客户端半暂不拆多入口 | 宿主按包注册 client 入口，多入口支持未确认；先内部模块化 |
| D5 | 零 npm 依赖 | 安装即用、无供应链风险、测试可离线跑 |
| D6 | 史官默认开启 + `scope.mode: all`（0.47.0 按框架 v2 改；原 0.46.0 为关闭 + sandbox） | 作者拍板：发布版就要能直接读真实会话；隐私优先的用户可一键改回 sandbox（README 有配法） |
