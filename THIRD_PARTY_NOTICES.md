# THIRD PARTY NOTICES

本项目（dsh小助手 / `dsh-xiaozhushou`）**零第三方 npm 依赖**：宿主半只使用 Node 内置模块（`node:fs`、`node:path`、`node:crypto` 等），客户端半只使用 DSH 宿主提供的 `react`。

## 一、代码

| 内容 | 许可 | 说明 |
|---|---|---|
| 插件代码（`index.js`、`client.js`、`core/*`、`roles/*`、`locale/*`） | MIT（见 `LICENSE`） | 本项目自写 |

## 二、美术素材

| 内容 | 来源 | 授权说明 |
|---|---|---|
| 看板娘「鲸鱼娘」形象（`assets/pet/pet.png`、`assets/pet/tail.png`） | 维护者使用 AI 绘图工具（字节跳动「豆包」）生成，并做裁剪、压缩等二次处理 | 本项目按 MIT 随代码释出；生成内容的使用遵循豆包用户协议（<https://www.doubao.com/legal/terms>）。如版权方有异议，请开 issue，维护者会替换为自绘 SVG 占位 |
| 侧栏图标 / 占位形象（`icon.svg`、`assets/whale-placeholder.svg`、`client.js` 内联 SVG） | 维护者自绘 | MIT（同 `LICENSE`） |

## 三、只读参考、未复制代码的官方资料

以下均为 DeepSeek 官方随 DSH 发布的包/文档，本项目只读文档与接口合同用于设计与实现，**未复制其代码**：

| 来源 | 用途 |
|---|---|
| `@deepseek-ai/dsh-agent-preset`（preset 声明形式） | 角色 preset 的声明方式 |
| `@deepseek-ai/dsh-agent-preset` 的 `cordis-plugin-development` 技能文档 | bundle 形态、插槽注册、展示清单 |
| `cordis_inspect_query` 查到的服务合同（`sessionQuery` / `schedule` / `tools` / `systemPrompt` 等） | 接口对齐 |

## 四、生态观察（未吸收代码或素材）

调研 DSH 生态的会话管理类插件时，只读功能说明与工程做法，未复制任何代码或美术资源。

## 五、将来引入时的登记模板

```markdown
### <名称>
- 链接 / commit / 版本：
- 版权方：
- 许可证：（MIT / Apache-2.0 / BSD / CC-BY* / 其它）
- 引入日期：
- 用途（哪个文件、做什么）：
- 许可要求履行情况：（保留版权声明 / 署名 / 相同方式共享 / 非商用限制）
```

**红线**：GPL/AGPL 代码不进入本插件；无许可证（NOASSERTION）视为禁止引入；含 NC 的只作非商业参考；含 SA 的衍生须同许可；署名是底线。

---

最后更新：2026-10-26（0.46.0 发布基线）
