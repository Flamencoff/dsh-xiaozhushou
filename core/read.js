/**
 * 史官读取策略（18_详细设计 §2.5；需求 R-HIS-01…R-HIS-05）
 *
 * 这一层是**纯函数**：给一批会话事件 + 档位 + 预算 + 排除规则，产出"该记什么"。
 * 真正的取事件（sessionQuery）由调用方做，这里不碰宿主，所以能离线测。
 *
 * 三档口径（02_史官读取档位与长记忆设计 v0.3）：
 *   summary（默认）：用户发言全文 + 每轮最终答复的"摘要"（不含原文、不含工具、不含思维链）
 *   body          ：再加助手最终正文原文 + 工具名与结果状态
 *   full          ：再加工具原始输出与思维链（默认关，逐工作区授权）
 *
 * 铁律：
 *   · 每条记录必须带引用（sessionId + seq + time），无引用不写；
 *   · 命中排除/脱敏规则的片段不原文落盘；
 *   · 超预算就截断并标 truncated，绝不悄悄少读。
 */

export const TIERS = ['summary', 'body', 'full']

export const DEFAULT_BUDGET = { maxEvents: 240, maxTokens: 8000, windowHours: 72 }

/** 脱敏规则（顺序敏感：先密钥，再路径，再手机号） */
const REDACTIONS = [
  { name: 'secret', re: /(sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*\S{8,}|Bearer\s+\S{12,}|machine-id\.key)/gi, with: '[已隐去密钥]' },
  // 2026-10-26 修 A-09：原来只认 X:\ 这种反斜杠盘符，正斜杠、UNC(\\host\share)、\\?\ 长路径全漏
  { name: 'path', re: /(?:\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+\\|\\\\\?\\)[^\s"'）)，。；]+/g, with: '[路径]' },
  { name: 'phone', re: /\b1[3-9]\d{9}\b/g, with: '[手机号]' },
]

/**
 * @param {Array<{seq:number,type:string,time:number,data:any}>} events 按 seq 升序
 * @param {{tier?:string, budgets?:object, exclude?:string[], now?:number}} options
 */
export function selectEvents(events, options = {}) {
  const tier = TIERS.includes(options.tier) ? options.tier : 'summary'
  const budgets = { ...DEFAULT_BUDGET, ...(options.budgets || {}) }
  const exclude = Array.isArray(options.exclude) ? options.exclude : []
  const now = Number(options.now) || Date.now()
  const windowMs = (Number(budgets.windowHours) || 72) * 3600 * 1000

  const records = []
  const stats = { read: 0, skippedByType: 0, skippedByWindow: 0, skippedByExclude: 0, redacted: 0, truncated: false, tokens: 0 }

  for (const event of events) {
    if (!event || typeof event.seq !== 'number') continue
    if (now - Number(event.time || 0) > windowMs) {
      stats.skippedByWindow += 1
      continue
    }
    const item = toRecord(event, tier, exclude, options.reduceAuthorGranularity)
    if (!item) {
      stats.skippedByType += 1
      continue
    }
    if (item.excluded) {
      stats.skippedByExclude += 1
      continue
    }
    if (records.length >= (Number(budgets.maxEvents) || DEFAULT_BUDGET.maxEvents)) {
      stats.truncated = true
      break
    }
    const cost = estimateTokens(item.record && item.record.text)
    if (stats.tokens + cost > (Number(budgets.maxTokens) || DEFAULT_BUDGET.maxTokens)) {
      stats.truncated = true
      break
    }
    if (item.redactions) stats.redacted += item.redactions
    stats.tokens += cost
    stats.read += 1
    records.push(item.record)
  }

  return {
    tier,
    records,
    stats,
    nextCursor: records.length ? Math.max(...records.map((r) => r.refs.seq)) : null,
  }
}

/** 单条事件 → 记录；不该读的类型返回 null */
/**
 * 判断一条 user/message 是不是"宿主注入"，不是用户的真实输入。
 * 设计决定（2026-10-26）：目标模式、系统提醒、自动授权、子代理返回等都不算用户言行。
 */
export const INJECTED_MARKERS = [
  '<goal_round>',
  '</goal_round>',
  'This is an automatically generated checkpoint',
  'compacted from an earlier span',
  'Current runtime context.',
  'The available skill catalog changed',
  '<system-reminder>',
  'Team message from',
  'Background subagent',
  'The goal is marked',
]

export function isInjected(text) {
  const value = String(text || '')
  if (!value) return false
  return INJECTED_MARKERS.some((marker) => value.includes(marker))
}
function toRecord(event, tier, exclude, reduceAuthor) {
  const { type, seq, time } = event
  const data = event.data || {}
  const refs = { sessionId: data.sessionId || event.sessionId || '', seq, time }

  if (type === 'user/message') {
    const raw = textOf(data)
    // 2026-10-26：把"不是用户真实输入"的注入消息排除掉（设计要求区分）
    // 例：目标模式回合、运行时上下文快照、系统提醒、团队消息、压缩说明、技能目录变更。
    if (isInjected(raw)) return null
    // K6：发布版默认降颗粒度（只留摘要）；用户自用可把 privacy.reduceAuthorGranularity 改 false 换回原话
    const reduced = reduceAuthor !== false
    return finish({ kind: 'user', refs, text: reduced ? summarize(raw) : raw }, exclude)
  }

  if (type === 'assistant/message') {
    if (tier === 'summary') {
      const raw = finalText(data)
      return finish({ kind: 'reply', refs, text: summarize(raw) }, exclude)
    }
    const raw = finalText(data)
    return finish({ kind: 'reply', refs, text: raw, usage: data.usage || null }, exclude)
  }

  if (type === 'tool/call') {
    if (tier === 'summary') return null
    return finish({ kind: 'tool', refs, text: `工具 ${data.name || '?'}` }, exclude)
  }

  if (type === 'tool/result') {
    if (tier === 'summary') return null
    const ok = data.error ? `失败：${data.error.name || ''}` : '成功'
    if (tier === 'body') {
      return finish({ kind: 'tool-result', refs, text: `结果 ${ok}` }, exclude)
    }
    return finish({ kind: 'tool-result', refs, text: `结果 ${ok}\n${clip(textOf(data), 2000)}` }, exclude)
  }

  if (type === 'assistant/attempt') {
    // 思维链：只有全量档才读
    if (tier !== 'full') return null
    return finish({ kind: 'reasoning', refs, text: clip(reasoningOf(data), 4000) }, exclude)
  }

  return null
}

/** 脱敏 + 组装记录 */
function finish(partial, exclude) {
  let text = String(partial.text || '')
  if (!text.trim()) return null

  for (const pattern of exclude) {
    if (pattern && text.includes(pattern)) return { excluded: true }
  }

  let redactions = 0
  for (const rule of REDACTIONS) {
    text = text.replace(rule.re, () => {
      redactions += 1
      return rule.with
    })
  }

  return { excluded: false, redactions, record: { ...partial, text } }
}

/** 摘要档只留结论句：第一条句子、最多 120 字 */
export function summarize(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const firstSentence = clean.split(/(?<=[。！？!?；;])/)[0] || clean
  return clip(firstSentence, 120)
}

export function estimateTokens(text) {
  const length = String(text || '').length
  // 中文约 1.5 字/token，粗估：2 字 = 1 token，最少 1
  return Math.max(1, Math.ceil(length / 2))
}

function clip(text, max) {
  const clean = String(text == null ? '' : text)
  return clean.length <= max ? clean : clean.slice(0, max) + '…'
}

function textOf(data) {
  const message = data.message || data
  const content = message && message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return ''
        if (block.type === 'text') return block.text || ''
        if (block.type === 'file') return `[附件 ${block.attachment && block.attachment.name ? block.attachment.name : ''}]`
        if (block.type === 'image') return '[图片]'
        return ''
      })
      .join('\n')
  }
  return ''
}

function finalText(data) {
  const fromContent = textOf(data)
  if (fromContent) return fromContent
  const stream = Array.isArray(data.stream) ? data.stream : []
  const texts = []
  for (const chunk of stream) {
    if (chunk && chunk.type === 'text-chunks' && Array.isArray(chunk.texts)) texts.push(chunk.texts.join(''))
  }
  return texts.join('')
}

function reasoningOf(data) {
  const stream = Array.isArray(data.stream) ? data.stream : []
  const parts = []
  for (const chunk of stream) {
    if (chunk && chunk.type === 'reasoning-chunks' && Array.isArray(chunk.texts)) parts.push(chunk.texts.join(''))
  }
  return parts.join('')
}
