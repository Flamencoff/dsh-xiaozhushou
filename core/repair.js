/**
 * 维修站 / 环境适配档案（M5；需求 R-ENG-07、证据 OLD-54）
 *
 * 用户的旧教训："插件一旦死掉，它自己的内容就取不出来——所以档案必须放在插件之外。"
 *
 * 所以：插件每次启动时，往**数据目录**写一份纯文本档案（不在插件包内），内容包含
 *   · 本机当前状态（版本、数据目录、依赖服务是否可用）
 *   · 诊断五步（照着做就能判断"哪一层坏了"）
 *   · DSH 大更新后要重新核对哪几处
 *   · 怎么卸载、怎么回滚、数据在哪
 *
 * 只写纯文本，不写密钥、不写会话内容。
 */

import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = '维修站.md'

export function writeRepairStation({ dataDir, store, config, runtime }) {
  const lines = []
  const now = new Date()
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  lines.push('# 维修站 · dsh小助手（dsh-xiaozhushou）')
  lines.push('')
  lines.push(`> 本文件由插件自己生成，放在数据目录里（不在插件包内）——插件坏了也能打开它。`)
  lines.push(`> 最近一次更新：${stamp}`)
  lines.push('')

  lines.push('## 一、当前状态')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 插件版本 | ${(runtime && runtime.version) || '未知'} |`)
  lines.push(`| 数据目录 | ${dataDir} |`)
  lines.push(`| 数据目录可写 | ${store && !store.lastError ? '是' : '否：' + ((store && store.lastError) || '未知')} |`)
  lines.push(`| 定时器 | ${runtime && runtime.timerOk ? '在跑' : '未运行（降级）'} |`)
  lines.push(`| 会话采集 | ${runtime && runtime.collectOk ? '正常' : '失败：' + ((runtime && runtime.collectError) || '未知')} |`)
  lines.push(`| 史官 | ${config && config.enabled && config.enabled.historian ? '已开启（' + (config.historian.tier || 'summary') + ' 档）' : '关闭（0.47.0 发布默认开启；这里是被手动关掉的）'} |`)
  lines.push(`| 降级模块 | ${(runtime && runtime.degraded && runtime.degraded.length) ? runtime.degraded.join('、') : '无'} |`)
  lines.push('')

  lines.push('## 二、诊断五步（照着做，判断哪一层坏了）')
  lines.push('')
  lines.push('1. **看接口**：浏览器打开 `http://127.0.0.1:<端口>/api/dsh-xiaozhushou/health`')
  lines.push('   - 打不开 → 插件宿主半没起来（看 DSH 插件管理里的报错）')
  lines.push('   - 能打开但 `ok:false` → 看 `checks` 里哪一项是 false')
  lines.push('2. **看界面**：左侧栏有没有「dsh小助手」图标？没有 → 客户端半没加载，刷新页面或重启 Web profile')
  lines.push('3. **看鲸鱼娘**：右上角有没有鲸鱼娘？有但拖不动 → 位置被夹到边界了，按 Esc 收起再展开会重新夹')
  lines.push('4. **看数据**：`数据目录` 下有没有 `看板.json` / `采集.json`？没有 → 定时器或采集坏了（`/health` 的 `timer`/`collect` 会标 false）')
  lines.push('5. **看史官**：`史官` 目录下有没有 `言行录\\`？没有 → 要么史官被手动关掉了（0.47.0 发布默认开启），要么还没跑过 `/historian/run`')
  lines.push('')

  lines.push('## 三、DSH 大更新后要重新核对的地方')
  lines.push('')
  lines.push('1. `shell.overlay` / `sidebar.panellist` / `main` 三个插槽名字是否还叫这个（用 `cordis_inspect_query` 查 Slots）；')
  lines.push('2. keyed 插槽是否仍要求 `key`（不是 `id`）——本插件按 keyed/list 分开注册；')
  lines.push('3. `sessionQuery` 的方法名与事件形状（本插件用 `listSessions`/`readTitleSnapshots`/`readSession`）；')
  lines.push('4. `ctx.get(\'timer\')` 是否仍可用（不要直接用 `ctx.interval` 属性，会抛错）；')
  lines.push('5. `plugin_manager install_bundle` 的安装/卸载语义。')
  lines.push('')

  lines.push('## 四、卸载与回滚')
  lines.push('')
  lines.push('```text')
  lines.push('plugin_manager · action=remove_bundle · target=dsh-xiaozhushou')
  lines.push('（如提示 restart-required，重启 Web profile）')
  lines.push('```')
  lines.push('')
  // 2026-10-26 修 B-11：史官言行录与 CEO 交接卡在数据目录的"上一级"，以前只说"数据全在数据目录"，
  // 用户备份/清理只删一个目录会漏。
  lines.push('- 主要数据在 `数据目录`；史官言行录在 `数据目录的上一级\\\\史官\\\\`；CEO 交接卡在 `数据目录的上一级\\\\CEO\\\\交接卡\\\\`；')
  lines.push('- 卸载不删数据；想彻底清掉要把上面两处一起删；')
  lines.push('- 不写用户的任何会话，不直接读会话正文（史官按档位读插件自己写的本地存档；0.47.0 发布默认开启，可关或切 sandbox）。')
  lines.push('')

  lines.push('## 五、红线（本插件永不做的）')
  lines.push('')
  lines.push('- 不往用户会话里写消息、不叫醒用户会话、不碰材料原件；')
  lines.push('- 本体不联网、无遥测；')
  lines.push('- 不接管别人的 DOM / 皮肤；不替换 app root。')

  const content = lines.join('\n') + '\n'
  const target = join(dataDir, FILE_NAME)
  try {
    mkdirSync(dataDir, { recursive: true })
    const tmp = target + '.tmp'
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, target)
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) }
  }
}

function pad(value) {
  return String(value).padStart(2, '0')
}
