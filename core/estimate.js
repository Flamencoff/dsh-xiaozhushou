/**
 * 工量估算与容量账本（旧 `算排期.py` / `03_排期参数_实测区间.md` 的规则版）
 *
 * 全部是确定性规则，不调模型：
 *   · 1 槽 = 30 分钟；一周预算 10 槽；
 *   · 周日不排；周六最多 3 槽；工作日一晚最多 3 槽；
 *   · 任务档位：小 2h=4 槽 / 中 4h=8 槽 / 多天 8h=16 槽；
 *   · 没截止的活按容量往后估一个“能排上的日子”，来源标 estimated，作者给截止即覆盖。
 */

export const SLOT_MINUTES = 30
export const WEEK_BUDGET_SLOTS = 10
export const SATURDAY_MAX_SLOTS = 3
export const WEEKDAY_EVENING_SLOTS = 3
export const SUNDAY_OFF = true

function pad(n) {
  return String(n).padStart(2, '0')
}

export function dateKey(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const text = String(value || '').trim()
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
  if (!match) return ''
  return `${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`
}

function parseDate(value) {
  const key = dateKey(value)
  if (!key) return null
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(value, n) {
  const date = value instanceof Date ? new Date(value.getFullYear(), value.getMonth(), value.getDate()) : parseDate(value)
  if (!date) return null
  date.setDate(date.getDate() + Number(n || 0))
  return date
}

/** 按标题/说明猜任务档位（槽数） */
export function estimateSlots(title = '', detail = '') {
  const text = String(title || '') + ' ' + String(detail || '')
  if (/(多天|项目|系统|开发|插件|部署|调试|代码|迁移|搭建)/.test(text)) return 16
  if (/(材料|报告|总结|方案|讲话|汇报|简报|文稿|PPT|课件|论文|制度|清单)/.test(text)) return 8
  if (/(会议|沟通|协调|请示|联系|电话|对接|通知|回复)/.test(text)) return 2
  if (/(调研|统计|核对|汇总|整理|阅读|学习)/.test(text)) return 4
  return 4
}

export function slotsLabel(slots) {
  const n = Math.max(1, Number(slots) || 1)
  if (n >= 16) return '多天（约 8 小时）'
  if (n >= 8) return '中（约 4 小时）'
  if (n >= 4) return '小（约 2 小时）'
  return n + ' 个 30 分钟'
}

/** 某一天能排几槽、为什么 */
export function capacityFor(day) {
  const date = parseDate(day)
  if (!date) return { slots: 0, reason: '日期看不懂' }
  const weekday = date.getDay()
  if (weekday === 0 && SUNDAY_OFF) return { slots: 0, reason: '周日不排' }
  if (weekday === 6) return { slots: SATURDAY_MAX_SLOTS, reason: '周六上限 3 槽（约 1.5 小时）' }
  return { slots: WEEKDAY_EVENING_SLOTS, reason: '工作日一晚 3 槽' }
}

/** 没截止时，按容量往后估算“大概哪天能排上”；有作者截止则原样保留 */
export function estimateDue({ now = new Date(), slots = 4, due = '' } = {}) {
  const author = dateKey(due)
  if (author) return { due: author, dueSource: 'author' }
  const need = Math.max(1, Number(slots) || 1)
  let remaining = need
  let cursor = addDays(now, 1)
  for (let i = 0; i < 60; i += 1) {
    const cap = capacityFor(cursor).slots
    if (cap > 0) remaining -= Math.min(cap, remaining)
    if (remaining <= 0) return { due: dateKey(cursor), dueSource: 'estimated' }
    cursor = addDays(cursor, 1)
  }
  return { due: dateKey(addDays(now, 14)), dueSource: 'estimated', note: '估算超出 60 天，先给两周后' }
}

const PRIORITY_WEIGHT = { 5: 5, 4: 4, 3: 3, 2: 2, 1: 1 }

/** 把已确认待办按截止/优先级装进未来 7 天；装不下就明说 */
export function buildSchedule({ todos = [], now = new Date(), maxDays = 7 } = {}) {
  const days = []
  for (let i = 0; i < maxDays; i += 1) {
    const date = addDays(now, i)
    const key = dateKey(date)
    const cap = capacityFor(date)
    days.push({ date: key, slots: cap.slots, reason: cap.reason, items: [] })
  }
  const sorted = (Array.isArray(todos) ? todos : [])
    .map((todo) => {
      const slots = Math.max(1, Number(todo.estimate_slots) || estimateSlots(todo.title, todo.detail))
      const due = dateKey(todo.due)
      return { ...todo, slots, due, priorityLevel: Number(todo.priority && todo.priority.level) || 1 }
    })
    .sort((a, b) => {
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1
      if (a.due && !b.due) return -1
      if (!a.due && b.due) return 1
      return (PRIORITY_WEIGHT[b.priorityLevel] || 0) - (PRIORITY_WEIGHT[a.priorityLevel] || 0)
    })
  const unscheduled = []
  let weekFree = WEEK_BUDGET_SLOTS
  for (const task of sorted) {
    let remaining = task.slots
    for (const day of days) {
      if (remaining <= 0 || weekFree <= 0) break
      if (task.due && day.date > task.due) break
      if (day.slots <= 0) continue
      const used = day.items.reduce((sum, item) => sum + item.slots, 0)
      const free = Math.max(0, Math.min(day.slots - used, weekFree))
      if (free <= 0) continue
      const take = Math.min(free, remaining)
      day.items.push({ id: task.id, title: task.title, slots: take, priorityLevel: task.priorityLevel, due: task.due || null, part: task.slots > 1 ? true : undefined })
      remaining -= take
      weekFree -= take
    }
    if (remaining > 0) {
      unscheduled.push({ id: task.id, title: task.title, slots: remaining, due: task.due || null, reason: task.due ? '截止前装不下' : '本周容量不够' })
    }
  }
  const usedSlots = days.reduce((sum, day) => sum + day.items.reduce((n, item) => n + item.slots, 0), 0)
  return {
    at: new Date(now).toISOString(),
    slotMinutes: SLOT_MINUTES,
    weekBudgetSlots: WEEK_BUDGET_SLOTS,
    usedSlots,
    days,
    unscheduled,
    note: unscheduled.length ? '有活装不下，往下顺延或砍范围' : '这周排得下',
  }
}
