# 发布流程

> 一次发布 = 一个 `release/<版本>` 分支 + 一次 `--no-ff` 合并 + 一个附注 tag。
> **所有 GitHub / npm 写操作都必须作者当次明确同意**；本文件只给命令，不代跑。

## 一、发布前（在 `release/<版本>` 分支）

1. 从最新 `main` 切 `release/<版本>`；
2. 同步版本号（两处）：`package.json` 的 `version`、`index.js` 的 `const VERSION`；
3. 写 `CHANGELOG.md`：新版本条目（Added / Changed / Removed / Fixed）；
4. 更新 README 的兼容性、配置、已知限制（有变化才改）；
5. 跑全部门禁：

```sh
node test/harness.mjs
node scripts/check-release.mjs
node scripts/check-imports.mjs
node --check index.js && node --check client.js
npm pack --dry-run          # 看 npm 包内容与体积
```

6. 真机验收（本机 DSH 装一遍）：`/health`、`/board`、`/refresh`、一次角色聊天、看板/浮窗手工清单；
7. 冷环境安装（发布前**必须**做一次）：新建一个 DSH profile，装本包，确认侧栏/看板/浮窗/接口正常，再卸载确认无残留。

> 发布说明口径（D-16）：本插件的 27 条 HTTP 路由是注册在**本机 127.0.0.1 的 DSH Web 服务**上的**回环接口**，
> 不是对外网关/服务；不另开端口、不做代理。写对外文案时不要写成"提供 API 服务"。

## 二、合并与 tag

```sh
git switch main
git merge --no-ff release/<版本> -m "merge: <本版主题>（v<版本>）"
git tag -a v<版本> -m "<一句话>"
```

- tag 不移动、不复用；发错就升版本重发；
- 合并后 `main` 必须仍能通过全部门禁。

## 三、构建产物

```sh
npm pack                                   # 生成 dsh-xiaozhushou-<版本>.tgz
node scripts/build-market-index.mjs        # 生成 dist/market-index.json（固定当前 commit）
```

`dist/` 不入库；把 tgz、`market-index.json`、`SHA256SUMS.txt` 一起归档到发布目录。

## 四、发布到 npm（进 DSH 内置「插件中心」需要这步）

前置：npm 账号（<https://www.npmjs.com/signup>，邮箱验证 + 建议开 2FA）。

```sh
npm login                    # 由作者本人登录，令牌不进仓库、不进对话
npm publish                  # 包名 dsh-xiaozhushou，公开
npm view dsh-xiaozhushou version
```

装：`dsh plugin --profile desktop add dsh-xiaozhushou`。
**未发 npm 也能被社区市场收录**（走 GitHub 源码安装），只是不会出现在「插件中心」一键装列表里。

## 五、发布到 GitHub（社区市场收录的前提）

1. 仓库公开：`Flamencoff/dsh-xiaozhushou`；
2. 描述一行：`dsh小助手：DSH 插件，秘书/CEO/史官三角色 + 待办台账 + 提醒 + 看板娘`；
3. Topics 必须包含：**`dsh-plugin`**（爬虫靠它识别），建议再加 `deepseek-harness`、`dsh`、`assistant`；
4. push `main` 与 tag：

```sh
git remote add origin https://github.com/Flamencoff/dsh-xiaozhushou.git
git push -u origin main
git push origin --tags
```

5. 用 `CHANGELOG.md` 的版本条目写 GitHub Release，附 tgz 与 `SHA256SUMS.txt`。

## 六、社区市场收录（dsh-plugin.org）

到 <https://dsh-plugin.org/zh/submit> 按模板提交（或开 `dshplugin/dsh-plugin-hub` 的 Issue）：

```text
### 仓库地址
https://github.com/Flamencoff/dsh-xiaozhushou

### 一句话价值
给 DSH 装一个看板 + 待办台账 + 三个角色：秘书陪聊、CEO 判断、史官只记不评；数据全在本地。

### 能力分类
工具与能力

### 安装命令
dsh plugin --profile desktop add github:Flamencoff/dsh-xiaozhushou
（已发 npm 时改：dsh plugin --profile desktop add dsh-xiaozhushou）

### 兼容与运行要求
DSH 0.2.1-rc.3 ~ 0.2.1-rc.5（engines.dsh: >=0.2.1-rc.3 <0.3.0）；Node >=20；Windows 10/11 已适配（Linux/macOS/鸿蒙未适配）

### 许可证
MIT

### 完整仓库
根目录 package.json；插件导出 apply(ctx)；README 含安装命令
```

收录后（初始状态 `unconfirmed`，人工核实后 `verified`），把 README 底部徽章注释换成实际详情页链接。

## 七、自定义插件市场索引（可选，官方 format 1）

如果想像官方"插件市场"那样在 DSH 里加一个自己的索引源：

```sh
node scripts/build-market-index.mjs --commit <tag 指向的 commit> --out market/index.json
git switch -c chore/market-index
git add market/index.json && git commit -m "chore(release): 更新市场索引 v<版本>"
git switch main && git merge --no-ff chore/market-index
```

把 `market/index.json` 放到 https 静态地址（GitHub Pages / raw.githubusercontent），
在 DSH「设置 → 插件市场」添加该 URL。索引格式依据随 DSH 发布的 `@deepseek-ai/dsh-plugin-market-index`。

## 八、发布后回归

1. 在干净 profile 里按 README 的三种安装方式各装一次；
2. 跑 `/health`、`/board`、一次聊天、一次提醒触发；
3. 卸载后确认：侧栏图标消失、无报错、数据目录保留；
4. 把结果记进 CHANGELOG 对应版本（一行即可，不写长报告）。

## 九、回滚

- 本机出问题：切回上一个好 tag，或 `git revert <合并提交>`；
- npm 包有严重问题：发新 patch 版本修，必要时 `npm deprecate` 旧版本；
- **禁止**改写已发布 tag / 已推送历史。
