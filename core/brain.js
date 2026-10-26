/**
 * 大脑层：唯一调用模型的地方（M4 模型版 + K1 轻量唤醒）
 *
 * 用户 2026-10-26："一切以功能实现为优先级，成本只是一层限制，不要什么都考虑 0 成本。"
 * 所以这里**允许真调模型**，但守住四条：
 *   1) 有开关（config.model.enabled）与单次 maxTokens 上限；
 *   2) 有超时（默认 20s），超时即取消；
 *   3) 任何失败都返回 ok:false，调用方退回规则版并**标注"规则版"**，不假装；
 *   4) 只发"结构化摘要"，绝不把会话原文塞给模型。
 *
 * 官方合同（本机核对 2026-10-26）：
 *   llm.stream({ provider, model, messages, system, maxTokens, temperature, signal })
 *     → AsyncIterable<StreamChunk>（text-delta / usage / finish）
 *   agentDefaultModel.currentSelection() → 当前默认模型
 */

export const DEFAULT_MODEL_CONFIG = {
  enabled: true,
  maxTokens: 500,
  timeoutMs: 20000,
  temperature: 0.3,
}

export function createBrain({ ctx, config, log }) {
  const settings = { ...DEFAULT_MODEL_CONFIG, ...((config && config.model) || {}) }
  const logger = typeof log === 'function' ? log : () => {}

  function llm() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    } catch {
      return undefined
    }
  }

  function currentModel() {
    try {
      const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      const pick = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null
      if (pick && pick.provider && pick.model) return { provider: pick.provider, model: pick.model }
    } catch {
      /* 取不到就走下面的兜底 */
    }
    const configured = settings.provider && settings.model ? { provider: settings.provider, model: settings.model } : null
    return configured
  }

  function available() {
    return Boolean(settings.enabled) && Boolean(llm()) && Boolean(currentModel())
  }

  /**
   * 问一次模型。
   * @param {{system?:string, prompt:string, maxTokens?:number, timeoutMs?:number}} request
   */
  async function ask(request) {
    if (!settings.enabled) return { ok: false, code: 'model_disabled', message: '模型版是关着的（config.model.enabled=false）' }
    const service = llm()
    if (!service || typeof service.stream !== 'function') return { ok: false, code: 'no_llm', message: '这个环境没有可用的模型服务' }
    const target = currentModel()
    if (!target) return { ok: false, code: 'no_model', message: '没有选默认模型（去设置里选一个）' }

    const maxTokens = clampInt(request && request.maxTokens, 32, 4000, settings.maxTokens)
    const timeoutMs = clampInt(request && request.timeoutMs, 1000, 120000, settings.timeoutMs)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const stream = service.stream({
        provider: target.provider,
        model: target.model,
        system: (request && request.system) || undefined,
        messages: [{ role: 'user', content: [{ type: 'text', text: String((request && request.prompt) || '') }] }],
        maxTokens,
        temperature: Number(settings.temperature) || 0.3,
        signal: controller.signal,
      })

      let text = ''
      const chunkTypes = new Set()
      const reasoning = { text: '' }
      let usage = null
      let finish = null
      for await (const chunk of stream) {
        if (!chunk) continue
        chunkTypes.add(String(chunk.type || '?'))
        // 有的模型/路由先吐别的 delta 类型，或把正文放在 message/content 里；
        // 只认 text-delta 会抓空（2026-10-26 实测：CEO 四问因此静默退规则版）
        if (chunk.type === 'text-delta') text += chunk.text || ''
        else if (String(chunk.type || '').includes('reasoning') && typeof chunk.text === 'string') reasoning.text += chunk.text
        else if (typeof chunk.text === 'string' && String(chunk.type || '').indexOf('reasoning') < 0) text += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finish = chunk.reason
          if (chunk.reason && chunk.reason.kind === 'error') {
            return { ok: false, code: 'model_error', message: '模型返回错误：' + (chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : '未知') }
          }
          if (chunk.reason && chunk.reason.kind === 'aborted') return { ok: false, code: 'model_aborted', message: '模型调用被取消' }
        }
      }
      if (!text.trim()) {
        const hint = reasoning.text.trim() ? '（只收到思考内容 ' + reasoning.text.trim().length + ' 字，正文没出来：多半是 maxTokens 被思考吃完）' : ''
        return { ok: false, code: 'empty_reply', message: '模型没说话' + hint + '（收到的块类型：' + Array.from(chunkTypes).join(',') + '）' }
      }
      return { ok: true, text: text.trim(), usage, finish, model: target.model, source: 'model' }
    } catch (error) {
      const aborted = controller.signal.aborted
      logger('brain ask failed: ' + String(error && error.message ? error.message : error))
      return {
        ok: false,
        code: aborted ? 'timeout' : 'model_failed',
        message: aborted ? `等了 ${Math.round(timeoutMs / 1000)} 秒还没回，先按规则版来` : '模型调用失败，先按规则版来',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return { ask, available, settings, currentModel }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.round(Math.max(min, n)))
}
