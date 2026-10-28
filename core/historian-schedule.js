/**
 * 史官节律：每天 21:45 静默记录（0 token），每周五 21:45 复盘（唤一次史官会话）。
 *
 * - 记录走 historian.record：读会话/写言行录/按规则更新记忆，不调模型；
 * - 复盘先由插件写事实底稿，再让绑定的史官会话读底稿写复盘/提 1–3 问（一周一轮 token）；
 * - 定时器只检查“到点没”，状态写 史官/调度状态.json，重启不会重复跑。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_DAILY_AT = '21:45'
export const DEFAULT_WEEKLY_AT = '21:45'
export const DEFAULT_WEEKLY_WEEKDAY = 5

function pad(n) {
  return String(n).padStart(2, '0')
}

export function localParts(now = new Date()) {
  return {
    date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
    time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    weekday: now.getDay(),
    minutes: now.getHours() * 60 + now.getMinutes(),
    now,
  }
}

function parseAt(value, fallback) {
  const text = String(value || '').trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) return fallback
  const h = Number(match[1])
  const m = Number(match[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return fallback
  return h * 60 + m
}

export function isoWeekKey(now = new Date()) {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return date.getUTCFullYear() + '-W' + pad(week)
}

export function dailyDue(now, at = DEFAULT_DAILY_AT, lastDate = '') {
  const p = localParts(now)
  const last = String(lastDate || '')
  if (last === p.date) return false
  const target = parseAt(at, 21 * 60 + 45)
  if (p.minutes >= target) return true
  // 昨天/更早漏跑：今天启动时补一次（不管现在几点）
  return Boolean(last) && last < p.date
}

export function weeklyDue(now, { weekday = DEFAULT_WEEKLY_WEEKDAY, at = DEFAULT_WEEKLY_AT, lastWeek = '' } = {}) {
  const p = localParts(now)
  const target = Number(weekday)
  const diff = (p.weekday - target + 7) % 7
  // 当天到点跑；之后两天内启动可补跑；再往后不补，等下个周期
  if (diff > 2) return false
  if (diff === 0 && p.minutes < parseAt(at, 21 * 60 + 45)) return false
  return isoWeekKey(now) !== String(lastWeek || '')
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function reviewDraft({ dataDir, now = new Date() }) {
  const day = localParts(now).date
  const historyRoot = join(dirname(dataDir), '史官', '言行录')
  const lines = []
  const weekAgo = now.getTime() - 7 * 86400000
  let files = []
  try {
    for (const month of readdirSync(historyRoot).filter((name) => /^\d{4}-\d{2}$/.test(name)).sort()) {
      for (const name of readdirSync(join(historyRoot, month)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))) {
        const dayValue = Date.parse(name.slice(0, 10) + 'T00:00:00')
        if (!Number.isFinite(dayValue) || dayValue < weekAgo) continue
        files.push(join(historyRoot, month, name))
      }
    }
  } catch {}
  for (const file of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (line.startsWith('- ') && line.includes('用户：')) lines.push(line)
      }
    } catch {}
  }
  let tasks = []
  try {
    tasks = readJson(join(dataDir, '任务.json'), { tasks: [] }).tasks || []
  } catch {}
  const open = tasks.filter((task) => !['完成', '已归档', '已记忆'].includes(task.status))
  const done = tasks.filter((task) => task.status === '完成')
  const recent = lines.slice(-12)
  return [
    '# 周复盘 · ' + isoWeekKey(now),
    '',
    '> 本周事实底稿（插件确定性生成，不调模型）；下面的“史官复盘”由史官会话补充。',
    '',
    '## 一、任务与待办',
    '',
    '- 任务板：未完成 ' + open.length + ' 条，已完成 ' + done.length + ' 条',
    ...(open.slice(0, 8).map((task) => '- 未完成：' + task.id + ' ' + task.title)),
    '',
    '## 二、言行录里你最近说过的',
    '',
    ...(recent.length ? recent : ['- 本周没有记到用户发言']),
    '',
    '## 三、待史官回答（只问 1–3 个）',
    '',
    '- 本周最值得记住的一件事是什么？',
    '- 哪件事反复出现、下周需要先办？',
    '',
    '## 四、史官复盘',
    '',
    '（等史官会话补充）',
    '',
  ].join('\n')
}

export function createHistorianSchedule({ dataDir, historian, historianChat, config, audit, log = () => {}, now = () => new Date() }) {
  const root = join(dirname(String(dataDir)), '史官')
  const stateFile = join(root, '调度状态.json')
  const schedule = (config && config.historian && config.historian.schedule) || {}
  const dailyAt = schedule.dailyAt || DEFAULT_DAILY_AT
  const weeklyAt = schedule.weeklyAt || DEFAULT_WEEKLY_AT
  const weeklyWeekday = Number.isInteger(schedule.weeklyWeekday) ? schedule.weeklyWeekday : DEFAULT_WEEKLY_WEEKDAY
  const enabled = schedule.enabled !== false
  let busy = false

  function state() {
    return readJson(stateFile, { version: 1, lastDailyDate: '', lastWeeklyKey: '' })
  }

  async function runDaily(force = false) {
    const at = now()
    const s = state()
    if (config && config.enabled && config.enabled.historian === false) return { ok: false, code: 'historian_disabled', message: '史官已关闭' }
    if (!force && !dailyDue(at, dailyAt, s.lastDailyDate)) return { ok: true, skipped: true, reason: 'not_due' }
    const result = await historian.record({ dryRun: false })
    const ok = Boolean(result && result.ok)
    const busy = Boolean(result && result.code === 'busy')
    // 部分会话失败也算“今天跑过”，否则 21:45 后会每 60 秒全量重扫到午夜
    const next = busy
      ? { ...s, lastDailyAttemptAt: at.toISOString() }
      : { ...s, lastDailyDate: localParts(at).date, lastDailyAt: at.toISOString(), lastDailyResult: result && result.message ? String(result.message).slice(0, 200) : '', lastDailyError: ok ? '' : String((result && result.message) || 'record failed').slice(0, 200) }
    writeJson(stateFile, next)
    audit && audit.write && audit.write({ role: 'historian', action: 'schedule:daily', target: 'all', result: result && result.ok ? 'ok' : 'failed', reason: String((result && result.message) || '').slice(0, 80) })
    log('historian daily: ' + ((result && result.message) || 'done'))
    return result
  }

  async function runWeekly(force = false) {
    const at = now()
    const s = state()
    if (config && config.enabled && config.enabled.historian === false) return { ok: false, code: 'historian_disabled', message: '史官已关闭' }
    if (!force && !weeklyDue(at, { weekday: weeklyWeekday, at: weeklyAt, lastWeek: s.lastWeeklyKey })) return { ok: true, skipped: true, reason: 'not_due' }
    // 复盘失败时每小时最多重试一次，避免每 60 秒真调一次模型
    if (!force && s.lastWeeklyAttemptAt) {
      const lastAttempt = Date.parse(s.lastWeeklyAttemptAt)
      if (Number.isFinite(lastAttempt) && at.getTime() - lastAttempt < 60 * 60 * 1000) return { ok: true, skipped: true, reason: 'weekly_retry_wait' }
    }
    const week = isoWeekKey(at)
    let file = ''
    try {
      mkdirSync(join(root, '周复盘'), { recursive: true })
      file = join(root, '周复盘', week + '.md')
      if (existsSync(file) && !readFileSync(file, 'utf8').includes('（等史官会话补充）')) {
        let i = 2
        while (existsSync(join(root, '周复盘', week + '-' + i + '.md'))) i += 1
        file = join(root, '周复盘', week + '-' + i + '.md')
      }
      writeFileSync(file, reviewDraft({ dataDir, now: at }), 'utf8')
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '周复盘底稿写不进去：' + String(error && error.message ? error.message : error) }
    }
    let chatText = ''
    let chatOk = false
    if (historianChat && typeof historianChat.chat === 'function') {
      try {
        const replied = await historianChat.chat('本周复盘：请读「' + file + '」，按底稿写本周复盘，只问作者 1–3 个最要紧的问题；不要编造。', { internal: true })
        chatOk = Boolean(replied && replied.ok)
        chatText = String((replied && replied.text) || '').trim()
      } catch (error) {
        chatOk = false
        chatText = '（史官会话没跑成：' + String(error && error.message ? error.message : error) + '）'
      }
    } else {
      chatText = '（史官会话还没绑定，底稿先留着）'
    }
    try {
      if (chatText) {
        const current = readFileSync(file, 'utf8')
        writeFileSync(file, current.replace('（等史官会话补充）', () => chatText), 'utf8')
      }
    } catch {}
    const next = chatOk
      ? { ...s, lastWeeklyKey: week, lastWeeklyAt: at.toISOString(), lastWeeklyFile: file, lastWeeklyChatOk: true }
      : { ...s, lastWeeklyAttemptAt: at.toISOString(), lastWeeklyFile: file, lastWeeklyChatOk: false }
    if (!writeJson(stateFile, next)) return { ok: false, code: 'state_write_failed', message: '周复盘状态写不进去，先停' }
    audit && audit.write && audit.write({ role: 'historian', action: 'schedule:weekly', target: week, result: 'ok', reason: file })
    log('historian weekly: ' + week)
    return { ok: true, week, file, chatOk, chatText }
  }

  async function check() {
    if (!enabled || busy) return { ok: true, skipped: true }
    busy = true
    try {
      const daily = await runDaily(false)
      const weekly = await runWeekly(false)
      return { ok: true, daily, weekly }
    } finally {
      busy = false
    }
  }

  return { check, runDaily, runWeekly, state, stateFile, dailyAt, weeklyAt, weeklyWeekday, enabled }
}
