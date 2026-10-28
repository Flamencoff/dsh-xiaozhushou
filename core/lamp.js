/**
 * 鲸鱼娘状态灯：单一状态机，输入四个可重叠条件，按固定优先级归一到唯一状态。
 *
 * 条件（可同时为真）：
 *   needsConfirm —— 有待确认事项（人工确认步骤）
 *   urgent       —— 有紧急/重要事项（4/5 级）
 *   working      —— 有会话/插件在工作
 *   hasTodo      —— 有待办或进行中的任务
 *
 * 输出五个状态互斥且穷尽：
 *   confirm  红闪 400ms
 *   urgent   红常亮
 *   working  黄闪 800ms
 *   todo     黄常亮
 *   idle     绿常亮
 */

export const LAMP_STATES = {
  confirm: { color: 'red', mode: 'blink', interval: 400, reason: '需要人工确认' },
  urgent: { color: 'red', mode: 'steady', interval: 0, reason: '有紧急/重要事项' },
  working: { color: 'warn', mode: 'blink', interval: 800, reason: '会话或插件在工作' },
  todo: { color: 'warn', mode: 'steady', interval: 0, reason: '有待办' },
  idle: { color: 'green', mode: 'steady', interval: 0, reason: '没有动作' },
}

export function classifyLamp({ needsConfirm = false, urgent = false, working = false, hasTodo = false } = {}) {
  if (needsConfirm) return { ...LAMP_STATES.confirm, state: 'confirm' }
  if (urgent) return { ...LAMP_STATES.urgent, state: 'urgent' }
  if (working) return { ...LAMP_STATES.working, state: 'working' }
  if (hasTodo) return { ...LAMP_STATES.todo, state: 'todo' }
  return { ...LAMP_STATES.idle, state: 'idle' }
}

export function lampDecisionOf({ pendingCount = 0, urgent = false, working = false, hasTodo = false } = {}) {
  return classifyLamp({ needsConfirm: Number(pendingCount) > 0, urgent, working, hasTodo })
}
