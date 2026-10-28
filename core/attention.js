/**
 * 统一事项视图：把“待办台账”和“CEO 任务板”合成同一套优先级。
 *
 * 之前三处各算各的：优先级只看台账、CEO 任务只看任务板、浮窗把两套硬拼，
 * 于是同一个 K-020 在浮窗里可能排在常规待办后面。这里只保留一套排序。
 */

import { computePriority } from './priority.js'
import { estimateSlots } from './estimate.js'

const OPEN_TASK_STATUS = new Set(['待办', '进行中'])

function levelOf(item) {
  return Math.max(1, Math.min(5, Number(item && item.priority && item.priority.level) || 1))
}

function durationOf(item) {
  const slots = Math.max(1, Number(item && item.estimate_slots) || estimateSlots((item && item.title) || '', (item && item.detail) || ''))
  const minutes = slots * 30
  const label = minutes >= 60 ? '约 ' + Math.round(minutes / 60 * 10) / 10 + ' 小时' : '约 ' + minutes + ' 分钟'
  return { estimate_slots: slots, durationMinutes: minutes, durationLabel: label }
}

function dueOf(item) {
  return String((item && item.due) || '').slice(0, 10)
}

function sortItems(a, b) {
  if (a.level !== b.level) return b.level - a.level
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1
  if (a.due && !b.due) return -1
  if (!a.due && b.due) return 1
  if (a.kind !== b.kind) return a.kind === 'task' ? -1 : 1
  return String(a.id).localeCompare(String(b.id))
}

export function buildAttention({ todos = [], tasks = [], now = new Date(), limit = 20 } = {}) {
  const items = []
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (!todo || todo.status !== '已确认') continue
    const priority = todo.priority || computePriority(todo)
    items.push({
      kind: 'todo',
      sourceLabel: '待办',
      id: String(todo.id || ''),
      title: String(todo.title || ''),
      status: String(todo.status || ''),
      due: dueOf(todo) || null,
      level: levelOf({ priority }),
      label: priority.label,
      priority,
      ...durationOf(todo),
    })
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !OPEN_TASK_STATUS.has(String(task.status || ''))) continue
    const priority = task.priority || computePriority(task)
    items.push({
      kind: 'task',
      sourceLabel: 'CEO 任务',
      id: String(task.id || ''),
      title: String(task.title || ''),
      status: String(task.status || ''),
      due: dueOf(task) || null,
      level: levelOf({ priority }),
      label: priority.label,
      priority,
      ...durationOf(task),
    })
  }
  const sorted = items.filter((item) => item.id && item.title).sort(sortItems).slice(0, Math.max(1, Number(limit) || 20))
  const groups = []
  for (const item of sorted) {
    let group = groups.find((entry) => entry.level === item.level)
    if (!group) {
      group = { level: item.level, label: item.label, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return {
    version: 1,
    at: new Date(now).toISOString(),
    count: sorted.length,
    items: sorted,
    groups,
    top: sorted[0] || null,
    note: sorted.length ? '' : '没有待办或进行中的 CEO 任务',
  }
}
