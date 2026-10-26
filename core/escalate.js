/**
 * 提醒的"是否唤醒轻量模型"判定（K1 决定：轻量唤醒，或按任务复杂度判断）
 *
 * 原则：
 *   · 简单事零成本：纯规则就能说清的（今天到期、还剩几天），不唤醒任何模型；
 *   · 复杂事才唤醒：多条交叉、说不清轻重、需要"一句话说清该怎么办"的，才用一次**轻量**模型；
 *   · 唤醒有上限：单次 token 上限 + 每次最多 N 条，超了退回规则版（带来源标注）；
 *   · 可整体关闭：`alarm.lightModel.enabled=false` 时永远走规则。
 *
 * 本模块只做**判定**（纯函数），不发起模型调用——调用在 M4 接上 CEO 的模型通道后启用。
 */

export const DEFAULT_LIGHT_MODEL = {
  enabled: true,
  maxTokens: 400,
  maxItems: 3,
  complexityThreshold: 3,
}

/**
 * @param {{dueReminders?:Array, config?:object}} input
 * @returns {{wake:boolean, reason:string, complexity:number, why?:string}}
 */
export function shouldWakeModel(input = {}) {
  const settings = { ...DEFAULT_LIGHT_MODEL, ...((input.config && input.config.alarm && input.config.alarm.lightModel) || {}) }
  const items = Array.isArray(input.dueReminders) ? input.dueReminders : []

  if (!settings.enabled) return { wake: false, reason: 'light_model_disabled', complexity: score(items) }
  if (!items.length) return { wake: false, reason: 'nothing_to_say', complexity: 0 }
  if (items.length > settings.maxItems) {
    return { wake: false, reason: 'too_many_items', complexity: score(items), why: `一次 ${items.length} 条太多，先只弹前 ${settings.maxItems} 条` }
  }

  const complexity = score(items)
  if (complexity >= Number(settings.complexityThreshold)) {
    return { wake: true, reason: 'complex_enough', complexity, why: '多条交叉或需要一句话说清怎么做，值得叫一次轻模型' }
  }
  return { wake: false, reason: 'simple_enough', complexity, why: '规则就能说清，不花钱' }
}

/**
 * 复杂度打分（可解释、可测）：
 *   · 每条 +1；
 *   · 紧急且重要的 +2；
 *   · 今天到期的 +1；
 *   · 标题长于 20 字（信息多）的 +1。
 */
export function score(items) {
  let total = 0
  for (const item of items || []) {
    total += 1
    if (Number(item && item.urgency) >= 3 && Number(item && item.importance) >= 3) total += 2
    if (dueToday(item && item.due)) total += 1
    if (String((item && item.title) || '').length > 20) total += 1
  }
  return total
}

function dueToday(due) {
  if (!due) return false
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return String(due) === today
}
