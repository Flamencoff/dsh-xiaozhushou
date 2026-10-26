/**
 * 任务意图识别（纯函数，零依赖）：CEO 聊天里"接下/完成/归档/存为记忆/转交秘书"这类硬动作。
 * 返回 { matched, taskId, action }。
 */
export function detectTaskIntent(input) {
  const text = String(input || '').trim()
  if (!text) return { matched: false }
  const idMatch = text.match(/\bK-\d{2,}\b/i)
  const taskId = idMatch ? idMatch[0].toUpperCase() : null
  const done = /(完成|办完|做完|搞定|已办|已经办|处理完)/.test(text)
  const transfer = /(交给|转给|转交|转派|让)\s*秘书/.test(text)
  const accept = /(接下|接手|接了|我来做|我来办|我来|开始做|开始办|这就办|开始干|先办|收到|好的|可以)/.test(text)
  const remember = /(存为记忆|记到史官|投喂史官|记忆卡|存进记忆)/.test(text)
  const archive = /(归档|存档|收尾|归档吧)/.test(text)

  if (!done && !transfer && !accept && !remember && !archive) return { matched: false }
  return {
    matched: true,
    taskId,
    action: remember ? '存为记忆' : archive ? '归档' : done ? '完成' : (transfer ? '转交秘书' : '进行中'),
  }
}

/** 给界面/回复用的一句人话 */
export function taskIntentLabel(intent) {
  if (!intent || !intent.matched) return ''
  if (intent.action === '完成') return '已完成'
  if (intent.action === '转交秘书') return '已转给秘书'
  if (intent.action === '归档') return '已归档'
  if (intent.action === '存为记忆') return '已存为记忆'
  return '已接下，状态改为进行中'
}
