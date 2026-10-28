/**
 * 看板模型（纯函数，不调模型、不写盘；R-DAT-05）
 *
 * M1：待办与会话数来自真实台账/采集；四问、CEO 单线、史官、排期仍是占位（M3/M4 接上）。
 * 结构见 18_详细设计 §3.3 / §3.4。
 */

import { fourQuestions, singleLine } from './analysis.js'
import { rankByPriority, groupByPriority, overallSignal, computePriority } from './priority.js'
import { buildSchedule } from './estimate.js'
import { buildSessionCards } from './session-cards.js'
import { buildAttention } from './attention.js'
import { lampDecisionOf } from './lamp.js'

function signalOf(attention, fallback) {
  const priority = attention && attention.top && attention.top.priority
  if (!priority) return fallback
  return { level: priority.level, label: priority.label, dots: priority.dots, color: priority.color, blink: priority.blink }
}

export function buildState(runtime = {}) {
  const stats = safeStats(runtime)
  const attention = buildAttention({ todos: stats.confirmed, tasks: runtime.openTasks || [], now: new Date(runtime.computedAt || Date.now()) })
  const ranked = rankByPriority(stats.confirmed)
  const top = ranked.slice(0, 3).map((item) => ({
    id: item.id,
    title: item.title,
    due: dueText(item.due),
    level: item.priority.level,
    levelLabel: item.priority.label,
    dots: item.priority.dots,
    color: item.priority.color,
  }))
  // 提醒长相由"优先级层"决定：5 级=3 红点+闪，4 级=2 红点，3 级=黄，2 级=橙，1 级=蓝
  const signal = signalOf(attention, overallSignal(stats.confirmed))
  const dot = signal.color
  const dots = signal.dots
  const blink = Boolean(signal.blink)

  const liveSessions = ((runtime.snapshot && runtime.snapshot.sessions) || []).filter((s) => s && s.live).length
  const openTasks = Array.isArray(runtime.openTasks) ? runtime.openTasks : []
  const working = liveSessions > 0 || openTasks.some((task) => task && task.status === '进行中')
  const urgent = attention.items.some((item) => Number(item.level) >= 4)
  const hasTodo = attention.items.length > 0
  const lamp = lampDecisionOf({ pendingCount: stats.pendingCount, urgent, working, hasTodo })

  return {
    version: 1,
    at: runtime.computedAt || new Date().toISOString(),
    dot: lamp.color,
    dots: 1,
    blink: lamp.mode === 'blink',
    lamp,
    level: signal.level,
    levelLabel: signal.label,
    count: stats.confirmed.length,
    attention,
    top,
    note: stats.confirmed.length ? '' : '今天没有已确认的待办',
    degraded: runtime.degraded || [],
    // 2026-10-26 修 B-3：浮窗"打瞌睡"以前永远不生效——buildState 从来没输出 quiet
    quiet: Boolean(runtime.quiet),
  }
}

export function buildBoard(runtime = {}) {
  const at = runtime.computedAt || new Date().toISOString()
  const stats = safeStats(runtime)
  const attention = buildAttention({ todos: stats.confirmed, tasks: runtime.openTasks || [], now: new Date(runtime.computedAt || Date.now()) })
  const ranked = rankByPriority(stats.confirmed)
  const signal = signalOf(attention, overallSignal(stats.confirmed))
  const snapshot = runtime.snapshot || { sessions: [], total: 0 }
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const live = sessions.filter((s) => s.live).length

  const groups = {
    you: stats.confirmed.filter((item) => item.due && item.due <= todayIso()).map((item) => ({ id: item.id, title: item.title })),
    // 2026-10-26 修 B-14：机器在跑的只列 live；标题空的给可读占位
    machine: sessions.filter((s) => s.live).slice(0, 3).map((s) => ({ id: s.id, title: s.title || '（无标题会话 ' + String(s.id).slice(-6) + '）', role: roleLabel(s.agentPreset) })),
    waiting: [],
  }

  return {
    version: 1,
    generatedAt: runtime.computedAt || at,
    reminder: {
      items: buildReminderItems(runtime, stats),
      reason: buildReminderReason(runtime, stats, groups),
      // 2026-10-26 修 FIX-05：没收到提醒时界面要能直说为什么
      alarm: {
        slots: (runtime.config && runtime.config.alarm && runtime.config.alarm.fixedTimes) || [],
        quiet: Boolean(runtime.quiet),
        pushEnabled: Boolean(runtime.config && runtime.config.alarm && runtime.config.alarm.push && runtime.config.alarm.push.enabled),
        note: buildAlarmNote(runtime, stats),
      },
    },
    four: runtime.four || fourQuestions({ ledger: runtime.ledger, snapshot: runtime.snapshot, now: new Date(runtime.computedAt || Date.now()) }),
    todos: {
      confirmed: ranked.slice(0, 8),
      pendingCount: stats.pendingCount,
      // 2026-10-26 修 B-01：界面要能直接确认候选，所以把候选清单也吐出来
      // 2026-10-26 修 FIX-01：以前只给前 8 条，第 9 条起界面看不到也确认不了
      pending: (stats.pending || []).slice(0, 50).map((item) => ({ id: item.id, title: item.title, due: item.due || null })),
      pendingTotal: stats.pendingCount,
      pendingHidden: Math.max(0, stats.pendingCount - Math.min(50, (stats.pending || []).length)),
      // 象限之上的一层：按 5→1 级聚合（FIX-01 改动里被误删，恢复）
      priorityGroups: groupByPriority(stats.confirmed),
      attention: signal,
    },
    groups,
    analysis: runtime.analysis || singleLine({ ledger: runtime.ledger, snapshot: runtime.snapshot, now: new Date(runtime.computedAt || Date.now()) }),
    historian: {
      // 2026-10-26 修 FIX-08：不把开发期代号（M3）给用户看
      // 0.47.0：带上开关与读取范围，界面别再说"只读 [实验]"（发布默认 all）
      enabled: Boolean(runtime.config && runtime.config.enabled && runtime.config.enabled.historian),
      scope: (runtime.config && runtime.config.historian && runtime.config.historian.scope && runtime.config.historian.scope.mode) || 'all',
      today: runtime.historianToday || { summary: '今天还没跑史官：点「真跑一次（写盘）」才会记录', did: [], decided: [], followups: [] },
    },
    schedule: buildSchedule({ todos: stats.confirmed, now: new Date(runtime.computedAt || Date.now()) }),
    attention,
    sessionCards: buildSessionCards({ snapshot, ledger: runtime.ledger, inbox: runtime.inbox, tasks: runtime.openTasks || [], now: new Date(runtime.computedAt || Date.now()) }),
    diagnostics: {
      skipped: stats.skipped + (runtime.collectSkipped || 0),
      degraded: runtime.degraded || [],
      dataDir: runtime.dataDir || '',
      sessions: { total: snapshot.total || sessions.length, shown: sessions.length, live, truncated: Boolean(snapshot.truncated) },
      note: snapshot.ok === false ? snapshot.message : '会话只读了标题与状态，没读内容',
    },
  }
}

/* ── 小工具 ─────────────────────────────────────────────── */

function buildAlarmNote(runtime, stats) {
  if (!stats.confirmed.length) return '还没有已确认的待办，所以不会响'
  if (runtime.quiet) return '现在是静默时段：只记账、不弹提醒'
  if (!(runtime.config && runtime.config.alarm && runtime.config.alarm.push && runtime.config.alarm.push.enabled)) return '推送是关着的（只会在看板显示）'
  const slots = (runtime.config && runtime.config.alarm && runtime.config.alarm.fixedTimes) || []
  return slots.length ? '下一次定点提醒：' + slots.join(' / ') : '提醒时间没配置'
}

function roleLabel(preset) {
  const text = String(preset || '')
  if (text.endsWith('secretary')) return '秘书'
  if (text.endsWith('ceo')) return 'CEO'
  if (text.endsWith('historian')) return '史官'
  return ''
}

/** 提醒条目：优先用"定点提醒真正算出来的那几条"，否则退回"今天到期的已确认" */
function buildReminderItems(runtime, stats) {
  const fromAlarm = Array.isArray(runtime.dueReminders) ? runtime.dueReminders : []
  if (fromAlarm.length) {
    return fromAlarm.slice(0, 3).map((item) => ({ title: item.title, note: dueText(item.due) }))
  }
  return stats.confirmed
    .filter((item) => item.due && item.due <= todayIso())
    .slice(0, 3)
    .map((item) => ({ title: item.title, note: dueText(item.due) }))
}

function buildReminderReason(runtime, stats, groups) {
  const alarm = runtime.lastAlarm
  if (alarm && alarm.suppressed && alarm.suppressed.some((entry) => entry.reason === 'quiet')) {
    return '现在是静默时段：照常算，不弹提醒'
  }
  if (stats.confirmed.length) {
    return `已确认 ${stats.confirmed.length} 条，其中 ${groups.you.length} 条今天到期`
  }
  return '还没有已确认的待办（扫描只出候选，确认后才提醒）'
}

function safeStats(runtime) {
  const empty = { confirmed: [], pendingCount: 0, doneCount: 0, droppedCount: 0, skipped: 0 }
  try {
    const stats = runtime.ledger && typeof runtime.ledger.stats === 'function' ? runtime.ledger.stats() : null
    return stats || empty
  } catch {
    return empty
  }
}

export function dueText(due) {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(String(due))) return due ? String(due) : '没定时间'
  const today = new Date(todayIso())
  const target = new Date(due)
  const days = Math.round((target - today) / 86400000)
  if (days === 0) return '今天到期'
  if (days > 0) return `还剩 ${days} 天`
  return `已过 ${-days} 天`
}

function todayIso() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function weekLabel(iso) {
  try {
    const d = new Date(iso)
    const day = (d.getDay() + 6) % 7
    const monday = new Date(d.getTime() - day * 86400000)
    const yyyy = monday.getFullYear()
    const mm = String(monday.getMonth() + 1).padStart(2, '0')
    const dd = String(monday.getDate()).padStart(2, '0')
    return `${yyyy}-W${mm}${dd}`
  } catch {
    return ''
  }
}
