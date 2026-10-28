/**
 * 会话任务卡 / 健康态（旧 `算任务卡.py` 的规则版，零模型）
 *
 * 旧版结论：不读内容时只能做“会话级状态”，不能假装知道哪句是任务。
 * 这里只用会话元数据 + 台账/收件箱的归属关系：
 *   working 正在跑 / overdue 已过期 / dueSoon 3 天内 / due 有截止
 *   blocked 等外部 / blank 空白 / stalled 搁置 / idle 静默
 */

const HEALTH_ORDER = { working: 0, overdue: 1, dueSoon: 2, due: 3, blocked: 4, idle: 5, stalled: 6, blank: 7 }
const HEALTH_LABEL = {
  working: '正在干活',
  overdue: '已过期未动',
  dueSoon: '3 天内到期',
  due: '有截止',
  blocked: '等外部',
  idle: '静默',
  stalled: '搁置待处置',
  blank: '空白',
}

function dateKey(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayDiff(due, now) {
  const d = dateKey(due)
  if (!d) return null
  const [y, m, day] = d.split('-').map(Number)
  const target = new Date(y, m - 1, day)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86_400_000)
}

function inboxItems(inbox) {
  try {
    if (!inbox || typeof inbox.list !== 'function') return []
    return inbox.list({ status: 'open' }) || []
  } catch {
    return []
  }
}

function todoLines(ledger) {
  try {
    const stats = ledger && typeof ledger.stats === 'function' ? ledger.stats() : null
    return stats && Array.isArray(stats.confirmed) ? stats.confirmed : []
  } catch {
    return []
  }
}

export function buildSessionCards({ snapshot = {}, ledger = null, inbox = null, tasks = [], now = new Date(), limit = 30 } = {}) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : []
  const todos = todoLines(ledger)
  const inboxRows = inboxItems(inbox)
  const openTasks = (Array.isArray(tasks) ? tasks : []).filter((task) => task && (task.status === '待办' || task.status === '进行中'))
  const cards = []
  for (const session of sessions.slice(0, Math.max(1, Number(limit) || 30))) {
    const id = String(session.id || '')
    if (!id) continue
    const title = String(session.title || '').trim() || '（无标题会话 ' + id.slice(-6) + '）'
    const linkedTodos = todos.filter((todo) => {
      const source = todo.source
      return source && ((typeof source === 'object' && source.sessionId === id) || source === id)
    })
    const linkedTasks = openTasks.filter((task) => String(task.sessionId || '') === id)
    const linkedInbox = inboxRows.filter((item) => item.source_session === id || item.sessionId === id)
    const blocked = linkedInbox.some((item) => item.blocked_by)
    const due = linkedTodos.map((item) => dateKey(item.due)).filter(Boolean).sort()[0] || linkedInbox.map((item) => dateKey(item.due)).filter(Boolean).sort()[0] || ''
    const diff = due ? dayDiff(due, now) : null
    const created = session.createdAt ? new Date(session.createdAt) : null
    const ageDays = created && !Number.isNaN(created.getTime()) ? Math.floor((now - created) / 86_400_000) : null
    let health = 'idle'
    if (session.live || linkedTasks.some((task) => task.status === '进行中')) health = 'working'
    else if (diff !== null && diff < 0) health = 'overdue'
    else if (diff !== null && diff <= 3) health = 'dueSoon'
    else if (diff !== null) health = 'due'
    else if (blocked) health = 'blocked'
    else if (!title || title.startsWith('（无标题')) health = 'blank'
    else if (ageDays !== null && ageDays >= 3) health = 'stalled'
    const relevant = Boolean(session.live || linkedTodos.length || linkedTasks.length || linkedInbox.length || /^dsh小助手/.test(title))
    if (!relevant) continue
    cards.push({
      id,
      title,
      live: Boolean(session.live),
      health,
      healthLabel: HEALTH_LABEL[health] || health,
      due: due || null,
      daysUntilDue: diff,
      idleDays: ageDays,
      blocked,
      preset: String(session.agentPreset || ''),
      linked: [
        ...linkedTasks.map((task) => ({ kind: 'task', id: task.id, title: task.title, level: (task.priority && task.priority.level) || 1, label: (task.priority && task.priority.label) || '常规' })),
        ...linkedTodos.map((todo) => ({ kind: 'todo', id: todo.id, title: todo.title, level: (todo.priority && todo.priority.level) || 1, label: (todo.priority && todo.priority.label) || '常规' })),
      ].slice(0, 3),
    })
  }
  cards.sort((a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9))
  return cards
}

export { HEALTH_LABEL, HEALTH_ORDER }
