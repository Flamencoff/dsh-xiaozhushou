/**
 * 会话候选待办扫描（规则版，零模型）
 *
 * 旧版 `算任务卡.py` 明确：哪句是任务、干到哪，必须读懂内容，不能零成本硬猜。
 * 所以这里只做“候选筛选”：从用户消息里挑出像待办/交代的句子，标来源与不确定，
 * 交给秘书/CEO 或界面确认；不自动确认、不自动提醒。
 */

import { estimateSlots } from './estimate.js'

const TASK_HINT = /(记一下|记下|待办|提醒我|别忘|要交|需要|完成|截止|安排|准备|周五|周六|周日|周一|周二|周三|周四|月底|下周|今天|明天|后天)/
const QUESTION_HINT = /(吗|怎么|为什么|是不是|能不能|要不要|如何|什么)[？?]?\s*$/
const DATE_HINT = /(\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|今天|明天|后天|本周[一二三四五六日天]|下周[一二三四五六日天]|周[一二三四五六日天]|月底)/

function pad(n) {
  return String(n).padStart(2, '0')
}

function localDate(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function textParts(content) {
  if (!Array.isArray(content)) return []
  return content.filter((part) => part && part.type === 'text').map((part) => String(part.text || '')).filter(Boolean)
}

function stripWrapper(text) {
  const marker = '【用户说】'
  const at = text.lastIndexOf(marker)
  return (at >= 0 ? text.slice(at + marker.length) : text).trim()
}

function sentences(text) {
  return String(text || '')
    .split(/[\n。；;！!？?]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 120)
}

/** 从会话事件里提取候选（不读助手输出，只读用户消息） */
export function candidatesFromEvents(events = [], { sessionId = '', now = new Date(), max = 3 } = {}) {
  const out = []
  const seen = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'user/message') continue
    const message = event.data && event.data.message ? event.data.message : event.data || {}
    if (message.source && /runtime|system|team|goal/i.test(String(message.source.kind || ''))) continue
    const raw = textParts(message.content || (event.data && event.data.content)).join('\n')
    const text = stripWrapper(raw)
    if (!text || !TASK_HINT.test(text)) continue
    for (const sentence of sentences(text)) {
      if (QUESTION_HINT.test(sentence)) continue
      if (!TASK_HINT.test(sentence)) continue
      const title = sentence.replace(/\s+/g, ' ').slice(0, 80)
      const key = title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      const dueHint = DATE_HINT.exec(sentence)
      const urgency = /(最紧急|紧急|马上|立刻|今天|今晚|截止)/.test(sentence) ? 2 : 1
      const importance = /(最重|重要|攻坚|领导|省局|市局)/.test(sentence) ? 2 : 1
      out.push({
        title,
        sessionId: String(sessionId || ''),
        source: 'session-scan',
        evidence: sentence.slice(0, 120),
        dueHint: dueHint ? dueHint[0] : '',
        urgency,
        importance,
        estimate_slots: estimateSlots(title, text),
        confidence: dueHint ? 'medium' : 'low',
        scannedAt: now.toISOString(),
      })
      if (out.length >= Math.max(1, Number(max) || 3)) return out
    }
  }
  return out
}

export function scanSummary(candidates = []) {
  if (!candidates.length) return '这次没扫到像待办的句子'
  return candidates.map((item, i) => (i + 1) + '. ' + item.title + '（' + item.confidence + '，约 ' + Math.max(1, Math.round(Number(item.estimate_slots) / 2)) + ' 小时）').join('\n')
}

export { localDate }
