/**
 * 提醒策略（旧 `算提醒.py` 的确认制规则，纯函数）
 *
 * 作者口径（2026-10-17 最新裁定）：
 *   · 每天三个定点，不再用“一天最多 2 条”硬压；
 *   · 确认制普通待办：已过期→08:05；今天到期→08:05/18:05；明天到期→18:05；
 *   · 循环待办：每天/每周一/每月，只在 08:05；
 *   · 估算待确认：默认只提醒一次，提醒后标 reminded；
 *   · 没事不发，同一件事同一时点同一天只一次。
 */

export const DEFAULT_SLOTS = ['08:05', '12:05', '18:05']
const MORNING = '08:05'
const EVENING = '18:05'

function pad(n) {
  return String(n).padStart(2, '0')
}

export function localDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateOnly(value) {
  const text = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function dayDiff(due, now) {
  const d = dateOnly(due)
  if (!d) return null
  const [y, m, day] = d.split('-').map(Number)
  const target = new Date(y, m - 1, day)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86_400_000)
}

function recurMatches(todo, now) {
  const recur = String(todo.recur || '').trim()
  if (!recur) return false
  const start = dateOnly(todo.recurStart) || localDate(now)
  if (localDate(now) < start) return false
  if (recur === 'daily') return true
  if (recur === 'weekly-mon') return now.getDay() === 1
  if (recur === 'monthly') {
    const [y, m, d] = start.split('-').map(Number)
    return now.getFullYear() === y && now.getMonth() + 1 === m && now.getDate() === d
  }
  return false
}

export function reminderKind(todo, slot, now = new Date(), slots = {}) {
  if (!todo || todo.status !== '已确认') return null
  const morning = slots.morning || MORNING
  const evening = slots.evening || EVENING
  if (slot === morning && todo.recur && recurMatches(todo, now)) return 'recur'
  if (todo.recur) return null
  const diff = dayDiff(todo.due, now)
  if (diff === null) {
    if (todo.due_source === 'estimated' && !todo.reminded && slot === evening) return 'estimate'
    return null
  }
  if (diff < 0 && slot === morning) return 'overdue'
  if (diff === 0 && (slot === morning || slot === evening)) return 'today'
  if (diff === 1 && slot === evening) return 'tomorrow'
  return null
}

export function reminderLine(todo, kind) {
  const title = String((todo && todo.title) || '').trim()
  if (kind === 'overdue') return title + '（截止 ' + todo.due + ' 已过期，还没动）'
  if (kind === 'today') return title + '（今天到期）'
  if (kind === 'tomorrow') return title + '（明天到期）'
  if (kind === 'recur') return title + '（循环提醒）'
  if (kind === 'estimate') return title + '（我估的截止是 ' + todo.due + '，要改就说一声）'
  return title
}

/**
 * @returns {{items: Array, reason:string, shouldSend:boolean}}
 */
export function selectReminders({ todos = [], slot, now = new Date(), seen = {}, morningSlot = MORNING, eveningSlot = EVENING } = {}) {
  const today = localDate(now)
  const items = []
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (!todo || !todo.id) continue
    const kind = reminderKind(todo, slot, now, { morning: morningSlot, evening: eveningSlot })
    if (!kind) continue
    const key = todo.id + '|' + slot + '|' + today
    if (seen && seen[key]) continue
    items.push({ key, id: todo.id, title: todo.title, kind, due: todo.due || null, line: reminderLine(todo, kind) })
  }
  items.sort((a, b) => {
    const order = { overdue: 0, today: 1, tomorrow: 2, estimate: 3, recur: 4 }
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9)
  })
  return { items, reason: items.length ? '按确认制待办规则' : '这个时点没有要提醒的', shouldSend: items.length > 0 }
}

export function markEstimateReminded(todos, id) {
  const item = (Array.isArray(todos) ? todos : []).find((todo) => todo && todo.id === id)
  if (!item) return false
  item.reminded = true
  item.remindedAt = new Date().toISOString()
  return true
}
