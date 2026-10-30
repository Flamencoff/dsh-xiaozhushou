# 贡献与 Git 规范

> 目标：**main 永远可发布，任何一次改动都能单独回退，一个分支只干一件事。**
> 本文件是唯一流程标准；`docs/ARCHITECTURE.md` 管模块边界，`docs/RELEASE.md` 管发布。

## 一、分支模型（只有三条线）

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 可发布、可回退的稳定线 | **禁止直接提交**；只接受合并；每次合并后 CI 必须全绿 |
| `feat/<要点>` | 新功能 / 新模块 | 从最新 `main` 切出，只做一件事 |
| `fix/<要点>` | 修缺陷 | 同上；再小的修也走分支 |
| `chore/<要点>`、`docs/<要点>`、`refactor/<要点>`、`test/<要点>` | 杂务 / 文档 / 重构 / 测试 | 同上 |

- 分支从**最新 main** 切出，生命周期不超过「一份可验收的改动」；
- 一个分支**只改一个模块或一件事**；跨模块的改动拆成多个分支，按依赖顺序合并；
- 分支合入后立即删除（本地 `git branch -d`）。

## 二、一次改动的完整流程

```sh
git switch main
git pull --ff-only                # 有远程后；本地仓库可跳过
git switch -c feat/<要点>

# …改代码 + 改测试 + 改文档（同一分支内完成）…

node test/harness.mjs             # 211 项必须全绿
node scripts/check-release.mjs    # 发布自检
node scripts/check-imports.mjs    # 依赖体检（解耦兜底）
git add -A
git commit                        # 提交信息格式见第三节

git switch main
git merge --no-ff feat/<要点>     # 保留合并提交
git tag -a v<版本> -m "<一句话>"   # 只有「发布批次」才打 tag，见第四节
```

## 三、提交信息格式

```text
<type>(<scope>): <一句话结论>

- 改了什么（≤5 条，写行为，不写"改了哪个文件"流水账）
- 怎么验证的（自测 / 接口 / 真机 / 截图）
```

- `type`：`feat` / `fix` / `chore` / `docs` / `refactor` / `test`
- `scope`：模块名（`ledger`、`alarm`、`historian`、`chat`、`board`、`pet`、`release`、`git`…）
- 标题 ≤ 60 字；**禁止**「①②③④」堆砌、禁止空提交信息、禁止 `update`/`fix bug` 这类无信息标题。

合并提交统一写：`merge: <这批改了什么>（<版本号或验收点>）`。

## 四、版本与 tag

- 版本号两处同步：`package.json` 的 `version` 与 `index.js` 的 `const VERSION`（发布自检会拦）；
- SemVer：破坏性变更升 minor（0.x 阶段）/ 明确写迁移说明；新增功能升 minor；修 bug 升 patch；
- **每次发布**（合并进 `main` 且要对外）打附注 tag：`git tag -a v0.46.0 -m "0.46.0 首个公开版本"`；
- **tag 不移动、不复用、不覆盖**；发错了只能升版本号发新 tag；
- 预发布用 `-rc.1` 后缀。

## 五、合并前闸门（缺一不可）

1. `node test/harness.mjs` → **211 passed, 0 failed**（数字随版本增长，以当版为准）；
2. `node scripts/check-release.mjs` → 版本一致、包体合规、无个人痕迹 / 密钥 / 运行数据；
3. `node scripts/check-imports.mjs` → 无循环依赖、无外部依赖、依赖方向正确；
4. 改了 `client.js` 或界面 → **重启 DSH 真机看一遍**再合；
5. 改了宿主路由 / 工具 → 真机至少调一次 `/health` + 一个业务接口；
6. `git status` 干净：无 `dist/`、无数据文件、无 `.env`、无临时脚本。

本地钩子（推荐每个克隆都装一次）：

```sh
git config core.hooksPath .githooks
```

## 六、文档规则（只维护 6 个文件，禁止文档泛滥）

| 文件 | 什么时候必须改 |
|---|---|
| `README.md` | 用户可见的能力、安装方式、配置项、兼容性、已知限制变化 |
| `CHANGELOG.md` | **每个合并进 main 的用户可见变更**都加一行；按 Keep a Changelog 分类 |
| `docs/ARCHITECTURE.md` | 模块边界、公共契约（路由 / 工具 / preset / 数据文件 schema）、解耦规则变化 |
| `docs/PRIVACY.md` | 读写范围、权限、数据文件、外部调用变化 |
| `docs/RELEASE.md` | 发布步骤、市场收录、npm / GitHub 配置变化 |
| `CONTRIBUTING.md` | 流程本身变化 |

**禁止**：
- 一个会话 / 一次改动新建一份 `xx_记录.md`、`xx_交接卡.md`；
- 把设计讨论、过程流水账写进仓库；
- 同一事实写在两处（以本表为准，其余位置只链接）。

设计决策只留一处：`CHANGELOG.md` 的版本条目（结果）+ `docs/ARCHITECTURE.md` 的「决策」小节（原因）。

## 七、模块化改动（"一切皆插件"）的额外规则

- 一个分支只动**一个模块**；改公共契约（路由路径、工具名、preset id、JSON 文件字段）算**跨模块**，需单开分支并在 `ARCHITECTURE` 记迁移说明；
- 新模块必须：有独立文件、显式依赖注入（不读全局）、有单测或 harness 用例、不反向依赖入口；
- 删除模块前先跑 `check-imports` 确认无引用；
- 拆分/合并模块时，先加测试再动代码（测试通过再合并）。

## 八、调研入口（遇到问题先查这里再问人）

| 问题 | 去哪里查 |
|---|---|
| DSH 插件/工具/服务怎么写 | 官方文档 <https://deepseek-harness.github.io/deepseek-harness/develop/>；本机已安装包的 `README.md` 与 `lib/types/*.d.ts`（Desktop 安装在 `app.asar` 内，用宿主文件读取工具读） |
| 某个服务 / 事件的真实签名 | `cordis_inspect_list` → `cordis_inspect_query`（Service / Event / Config / Slots） |
| bundle / patch 怎么写 | 技能 `cordis-plugin-development`、`cordis-composition-reference`；官方《打包与安装插件》文档 |
| 插件市场索引格式 | 本机 `@deepseek-ai/dsh-plugin-market-index` 的 README 与 `lib/index.js`；`scripts/build-market-index.mjs` |
| 社区市场收录规则 | <https://dsh-plugin.org/zh/submit>（公开仓库 + `dsh-plugin` topic + README 安装命令 + 根 `package.json`） |
| 现有实现为什么这么写 | `docs/ARCHITECTURE.md` 决策小节 → `CHANGELOG.md` |

## 九、红线

1. **不 force push、不改写已打 tag 的历史**（不 `rebase` / `filter-branch` 已发布提交）；
2. **不未经作者当次明确同意就 push / 建 PR / 发布 npm / 调 GitHub 写接口**；
3. 运行数据、会话原文、密钥、个人身份信息**永不入库**；
4. 不为了让测试变绿而改期望值——除非同一个提交里写清原因；
5. 发布相关操作以 `docs/RELEASE.md` 为准，不即兴发挥。
