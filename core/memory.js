/**
 * 长期记忆（D-19 · 简化版：四个 Markdown 文件）
 *
 * 放在 `<dataDir>/记忆/`：
 *   · 用户画像.md      —— 交代总量、时间习惯、最近一条（事实归纳，不猜性格）
 *   · 近期交代.md      —— 最近 14 天明确交代的事（台账/任务板原文；另附角色对话与言行录摘句）
 *   · 长期规划.md      —— 未完成的已确认待办 + 未完成任务（按截止日）
 *   · 情绪与处境.md    —— 只做事实计数，不做情绪推断
 *
 * 纪律：
 *   1) 内容由**确定性规则**生成，不调模型：来源只有插件自己写的本地文件——台账/任务板、
 *      角色对话存档（`<dataDir>/<角色>/对话/*.md`）、史官言行录（`<数据目录上级>/史官/言行录/*`）；
 *      **不直接读**宿主的原始会话正文；
 *   2) 周更：首次或距上次 ≥7 天才重写（`记忆/状态.json` 记 lastUpdatedAt）；
 *      只重写每个文件 `<!-- AUTO:START -->…<!-- AUTO:END -->` **自动区**，区外手写内容永远保留；
 *   3) 秘书/CEO 上下文只读**摘要/相关片段**（有长度上限），不整篇塞进去；
 *   4) 只写数据目录内的 `记忆/`，写不进去如实返回 ok:false。
 *
 * 依赖规则：只 import `node:` 与显式传入的 store/dataDir，不读全局、不反向依赖入口。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MEMORY_DIR = '记忆'
export const MEMORY_WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** 自动区标记：周更只改这两行之间的内容，外面是用户手写区 */
export const AUTO_START = '<!-- AUTO:START -->'
export const AUTO_END = '<!-- AUTO:END -->'

/** 四个记忆文件（顺序固定，便于看板/文档引用） */
export const MEMORY_FILES = [
  { key: 'profile', name: '用户画像.md', title: '用户画像', what: '交代总量、时间习惯、最近一条交代（来源：台账/任务板）' },
  { key: 'recent', name: '近期交代.md', title: '近期交代', what: '最近 14 天明确交代的事（台账/任务板原文；另附角色对话与言行录最近摘句）' },
  { key: 'plan', name: '长期规划.md', title: '长期规划', what: '未完成的已确认待办与任务（按截止日）' },
  { key: 'mood', name: '情绪与处境.md', title: '情绪与处境', what: '只做事实计数，不做情绪推断' },
]

const STATUS_DONE = '已完成'
const STATUS_IGNORED = '已忽略'
const STATUS_CONFIRMED = '已确认'
const STATUS_CANDIDATE = '候选'

export function createMemory({ store, dataDir, now = () => new Date() }) {
  const root = join(dataDir, MEMORY_DIR)
  const historianRecordRoot = join(dirname(dataDir), '史官', '言行录')
  const ROLE_DIRS = ['秘书', 'CEO', '史官']

  function filePath(name) {
    return join(root, name)
  }

  function localDay(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
  }

  function stamp(date) {
    return localDay(date) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }

  /** 四文件缺失才创建（已有文件绝不覆盖，哪怕没有自动区标记也保留原内容） */
  function ensure() {
    const created = []
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      return { ok: false, created, root, message: '记忆目录建不了（数据目录不可写？）' }
    }
    for (const file of MEMORY_FILES) {
      const target = filePath(file.name)
      if (existsSync(target)) continue
      try {
        writeFileSync(target, skeleton(file), 'utf8')
        created.push(file.name)
      } catch {
        return { ok: false, created, root, message: '记忆文件写不进去：' + file.name }
      }
    }
    return { ok: true, created, root }
  }

  function status() {
    try {
      const data = store.read(MEMORY_DIR + '/状态.json', { version: 1, lastUpdatedAt: '' }) || {}
      return { lastUpdatedAt: typeof data.lastUpdatedAt === 'string' ? data.lastUpdatedAt : '', reason: data.reason || '' }
    } catch {
      return { lastUpdatedAt: '', reason: '' }
    }
  }

  /** 首次或距上次 ≥ 7 天算到期 */
  function due(at) {
    const last = Date.parse(status().lastUpdatedAt || '')
    if (!Number.isFinite(last)) return true
    return at.getTime() - last >= MEMORY_WEEK_MS
  }

  function facts(at) {
    let ledger = { items: [] }
    let tasks = { tasks: [] }
    try {
      ledger = store.read('待办.json', { version: 1, items: [] }) || { items: [] }
    } catch {
      ledger = { items: [] }
    }
    try {
      tasks = store.read('任务.json', { version: 1, tasks: [] }) || { tasks: [] }
    } catch {
      tasks = { tasks: [] }
    }
    const items = Array.isArray(ledger.items) ? ledger.items.filter((item) => item && typeof item.title === 'string') : []
    const taskList = Array.isArray(tasks.tasks) ? tasks.tasks.filter((task) => task && typeof task.title === 'string') : []
    const counts = {
      total: items.length,
      done: items.filter((item) => item.status === STATUS_DONE).length,
      ignored: items.filter((item) => item.status === STATUS_IGNORED).length,
      confirmed: items.filter((item) => item.status === STATUS_CONFIRMED).length,
      pending: items.filter((item) => item.status === STATUS_CANDIDATE).length,
      tasksTotal: taskList.length,
      tasksOpen: taskList.filter((task) => task.status !== '完成').length,
      tasksDone: taskList.filter((task) => task.status === '完成').length,
    }
    const open = items.filter((item) => item.status === STATUS_CONFIRMED || item.status === STATUS_CANDIDATE)
    const overdue = open.filter((item) => item.due && dayNumber(item.due) !== null && dayNumber(item.due) < dayNumber(localDay(at)))
    const weekAgo = at.getTime() - 7 * 86400000
    const recentAdded = items.filter((item) => Date.parse(item.createdAt || '') >= weekAgo)
    const recentDone = items.filter((item) => item.status === STATUS_DONE && Date.parse(item.updatedAt || item.createdAt || '') >= weekAgo)
    return {
      at,
      items,
      taskList,
      counts,
      open,
      overdue,
      recentAdded,
      recentDone,
      // D-19 来源补齐：只读插件自己写的本地存档，不直接读宿主原始会话正文
      roleDialogLines: readRoleDialogLines(at, 7, 6),
      historianLines: readHistorianLines(at, 7, 6),
    }
  }

  /** 规则生成四个文件**自动区**内容（确定性，不调模型） */
  function renderAuto(data) {
    const at = data.at
    const head = '> 最近更新：' + stamp(at) + '（史官规则周更，不调模型；本段由插件自动维护）\n'
    const recentParts = [recentLines(data, 14, 15) || '- 最近 14 天没有新的交代']
    if (data.roleDialogLines.length) recentParts.push('\n## 角色对话里你说过的（本地存档，最近 7 天）\n' + data.roleDialogLines.join('\n'))
    if (data.historianLines.length) recentParts.push('\n## 言行录最近记到的（最近 7 天）\n' + data.historianLines.join('\n'))
    return {
      '用户画像.md':
        head +
        '\n## 交代总量\n' +
        '- 待办台账共 ' + data.counts.total + ' 条：已完成 ' + data.counts.done + '、已确认 ' + data.counts.confirmed + '、候选 ' + data.counts.pending + '、已忽略 ' + data.counts.ignored + '\n' +
        '- 共享任务板共 ' + data.counts.tasksTotal + ' 条：未完成 ' + data.counts.tasksOpen + '、已完成 ' + data.counts.tasksDone + '\n' +
        '\n## 时间习惯\n' +
        weekdayHabit(data.items) + '\n' +
        '\n## 最近一条交代\n' +
        (lastItemLine(data.items) || '- 还没有记过待办') + '\n',
      '近期交代.md': head + '\n' + recentParts.join('\n') + '\n',
      '长期规划.md': head + '\n' + (planLines(data, 10) || '- 目前没有未完成的长期事项') + '\n',
      '情绪与处境.md':
        head +
        '\n## 近 7 天\n' +
        '- 新增 ' + data.recentAdded.length + ' 条、完成 ' + data.recentDone.length + ' 条、当前逾期 ' + data.overdue.length + ' 条\n' +
        '\n## 当前处境\n' +
        '- 待确认 ' + data.counts.pending + ' 条、已确认 ' + data.counts.confirmed + ' 条、任务板未完成 ' + data.counts.tasksOpen + ' 条\n' +
        '- 最紧的一条：' + (tightestLine(data.open) || '无') + '\n' +
        '- 处境：' + (data.overdue.length > 0 || data.counts.pending > 5 ? '有积压，先清逾期与待确认' : '节奏正常') + '\n',
    }
  }

  /** 周更：首次或 ≥7 天才写；只替换自动区，手写内容保留 */
  function maybeWeeklyUpdate(options = {}) {
    const at = options.now instanceof Date ? options.now : now()
    const ensured = ensure()
    if (!ensured.ok) return { ok: false, code: 'ensure_failed', message: ensured.message, root }
    if (!options.force && !due(at)) {
      return { ok: true, skipped: true, root, lastUpdatedAt: status().lastUpdatedAt, message: '还没到 7 天，记忆不重写' }
    }
    const data = facts(at)
    const rendered = renderAuto(data)
    const written = []
    try {
      for (const file of MEMORY_FILES) {
        const target = filePath(file.name)
        const current = readName(file.name)
        const merged = replaceAutoBlock(current || skeleton(file), rendered[file.name])
        const tmp = target + '.tmp'
        writeFileSync(tmp, merged, 'utf8')
        renameSync(tmp, target)
        written.push(file.name)
      }
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '记忆写不进去：' + messageOf(error), written, root }
    }
    const wrote = store.write(MEMORY_DIR + '/状态.json', {
      lastUpdatedAt: at.toISOString(),
      reason: String(options.reason || 'weekly'),
      counts: data.counts,
    })
    return {
      ok: true,
      skipped: false,
      written,
      root,
      lastUpdatedAt: at.toISOString(),
      counts: data.counts,
      statusWritten: Boolean(wrote),
      message: '记忆已周更：' + written.length + ' 个文件',
    }
  }

  /**
   * 给秘书/CEO 的上下文摘要：只读片段（每段截断 + 总长上限），不整篇塞。
   * 史官不读记忆（它只记录，不给判断找依据）。
   */
  function summaryFor(role, options = {}) {
    if (role === 'historian') return ''
    const maxChars = clamp(Number(options.maxChars) || 480, 80, 1200)
    const parts = []
    parts.push('用户画像：' + pickLines(readName('用户画像.md'), 3, 150))
    parts.push('近期交代：' + pickLines(readName('近期交代.md'), 4, 180))
    if (role === 'ceo') parts.push('长期规划：' + pickLines(readName('长期规划.md'), 3, 140))
    const text = parts.filter((part) => part && !part.endsWith('：')).join('\n')
    if (!text) return ''
    return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…'
  }

  function readName(name) {
    try {
      const target = filePath(name)
      if (!existsSync(target)) return ''
      return readFileSync(target, 'utf8')
    } catch {
      return ''
    }
  }

  /** 角色对话存档里"我"说过的话（插件自己写的 md，不碰宿主原始会话） */
  function readRoleDialogLines(at, days, limit) {
    const cutoff = at.getTime() - days * 86400000
    const entries = []
    for (const roleDir of ROLE_DIRS) {
      const folder = join(dataDir, roleDir, '对话')
      let files = []
      try {
        files = readdirSync(folder).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
      } catch {
        continue
      }
      for (const file of files) {
        const dayValue = dayNumber(file.slice(0, 10))
        if (dayValue === null || dayValue < cutoff) continue
        let text = ''
        try {
          text = readFileSync(join(folder, file), 'utf8')
        } catch {
          continue
        }
        for (const line of text.split(/\r?\n/)) {
          const match = /^\*\*我\*\*[:：]\s*(.+)$/.exec(line.trim())
          if (!match || !match[1].trim()) continue
          entries.push({ day: file.slice(0, 10), line: '- ' + file.slice(0, 10) + '｜' + roleDir + '：' + clip(match[1].trim(), 100) })
        }
      }
    }
    entries.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    return entries.slice(0, limit).map((entry) => entry.line)
  }

  /** 史官言行录里最近记到的用户内容（插件自己写的 md；只取"用户："行） */
  function readHistorianLines(at, days, limit) {
    const cutoff = at.getTime() - days * 86400000
    const entries = []
    let months = []
    try {
      months = readdirSync(historianRecordRoot).filter((name) => /^\d{4}-\d{2}$/.test(name)).sort().slice(-2)
    } catch {
      return []
    }
    for (const month of months) {
      let files = []
      try {
        files = readdirSync(join(historianRecordRoot, month)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
      } catch {
        continue
      }
      for (const file of files) {
        const day = file.slice(0, 10)
        const dayValue = dayNumber(day)
        if (dayValue === null || dayValue < cutoff) continue
        let text = ''
        try {
          text = readFileSync(join(historianRecordRoot, month, file), 'utf8')
        } catch {
          continue
        }
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('- ') || !trimmed.includes('用户：')) continue
          const body = trimmed.slice(2).replace(/\s*\[来源:[^\]]*\]\s*$/, '').trim()
          entries.push({ day, line: '- ' + day + '｜言行录：' + clip(body, 100) })
        }
      }
    }
    entries.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    return entries.slice(0, limit).map((entry) => entry.line)
  }

  return { root, ensure, status, due, maybeWeeklyUpdate, summaryFor, files: MEMORY_FILES }
}

/* ── 自动区 / 骨架 ─────────────────────────────────────────── */

function skeleton(file) {
  return [
    '# ' + file.title,
    '',
    '> ' + file.what,
    '> 手写内容可以直接加在下面；只有 ' + AUTO_START + ' 与 ' + AUTO_END + ' 之间的内容会被周更重写。',
    '',
    AUTO_START,
    '（还没生成：史官跑一次后按周更新这里）',
    AUTO_END,
    '',
  ].join('\n')
}

/**
 * 只替换自动区；没有标记的旧文件把原内容当"手写区"保留，在末尾补一个自动区。
 * @param {string} existing 现有文件内容
 * @param {string} body 新的自动区内容
 */
function replaceAutoBlock(existing, body) {
  const text = String(existing || '')
  const start = text.indexOf(AUTO_START)
  const end = text.indexOf(AUTO_END)
  const clean = String(body || '').replace(/\r?\n+$/, '')
  if (start >= 0 && end > start) {
    return text.slice(0, start + AUTO_START.length) + '\n' + clean + '\n' + text.slice(end)
  }
  const head = text.replace(/\s+$/, '')
  return (head ? head + '\n\n' : '') + AUTO_START + '\n' + clean + '\n' + AUTO_END + '\n'
}

/* ── 规则生成的小工具（全部确定性，不猜） ─────────────────── */

function pad(n) {
  return String(n).padStart(2, '0')
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}

function dayNumber(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''))
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function weekdayHabit(items) {
  const counts = new Map()
  let dated = 0
  for (const item of items) {
    const n = dayNumber(item.due)
    if (n === null) continue
    dated += 1
    const day = WEEKDAYS[new Date(n).getUTCDay()]
    counts.set(day, (counts.get(day) || 0) + 1)
  }
  if (!dated) return '- 还没有带截止日的交代（以后有日期就能看出习惯）'
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2)
  return '- 带截止日的 ' + dated + ' 条，最常落在 ' + top.map(([day, n]) => day + '（' + n + ' 条）').join('、')
}

function lastItemLine(items) {
  const latest = items
    .slice()
    .sort((a, b) => Date.parse(b.createdAt || b.updatedAt || '') - Date.parse(a.createdAt || a.updatedAt || ''))[0]
  if (!latest) return ''
  return '- ' + String(latest.createdAt || latest.updatedAt || '').slice(0, 10) + '｜' + latest.id + '｜' + clip(latest.title, 60) + '（' + latest.status + '）'
}

function recentLines(data, days, limit) {
  const since = data.at.getTime() - days * 86400000
  const todos = data.items
    .filter((item) => Date.parse(item.createdAt || item.updatedAt || '') >= since)
    .map((item) => ({ at: Date.parse(item.createdAt || item.updatedAt || ''), line: '- ' + String(item.createdAt || '').slice(0, 10) + '｜' + item.id + '｜' + clip(item.title, 80) + '（' + item.status + (item.due ? '，截止 ' + item.due : '') + '）' }))
  const tasks = data.taskList
    .filter((task) => Date.parse(task.createdAt || task.updatedAt || '') >= since)
    .map((task) => ({ at: Date.parse(task.createdAt || task.updatedAt || ''), line: '- ' + String(task.createdAt || '').slice(0, 10) + '｜' + task.id + '｜' + clip(task.title, 80) + '（' + task.status + '，' + assigneeName(task.assignee) + '）' }))
  return todos.concat(tasks)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((entry) => entry.line)
    .join('\n')
}

function planLines(data, limit) {
  const todos = data.items
    .filter((item) => item.status === STATUS_CONFIRMED)
    .map((item) => ({ due: dayNumber(item.due) === null ? Infinity : dayNumber(item.due), line: '- ' + (item.due ? '截止 ' + item.due : '无截止日') + '｜' + item.id + '｜' + clip(item.title, 80) + '（已确认）' }))
  const tasks = data.taskList
    .filter((task) => task.status !== '完成')
    .map((task) => ({ due: Infinity, line: '- 无截止日｜' + task.id + '｜' + clip(task.title, 80) + '（' + task.status + '，' + assigneeName(task.assignee) + '）' }))
  return todos.concat(tasks)
    .sort((a, b) => a.due - b.due)
    .slice(0, limit)
    .map((entry) => entry.line)
    .join('\n')
}

function tightestLine(open) {
  const dated = open.filter((item) => dayNumber(item.due) !== null).sort((a, b) => dayNumber(a.due) - dayNumber(b.due))
  const pick = dated[0] || open[0]
  if (!pick) return ''
  return pick.id + '｜' + clip(pick.title, 40) + (pick.due ? '（截止 ' + pick.due + '）' : '')
}

function assigneeName(assignee) {
  if (assignee === 'ceo') return 'CEO'
  if (assignee === 'secretary') return '秘书'
  if (assignee === 'historian') return '史官'
  return String(assignee || '未指派')
}

function pickLines(markdown, limit, perLine) {
  const lines = String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .slice(0, limit)
    .map((line) => clip(line.slice(2), perLine))
  return lines.join('；')
}

function clip(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : value.slice(0, max) + '…'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}
