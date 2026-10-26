/**
 * 真推送（A3）+ 沙盒隔离
 *
 * 用户 2026-10-26 要求：
 *   "A3 要真推送，你做实验就行了，但仅限你的实验数据；我的真实数据暂时不能用，
 *    避免写到了发布版本里面去。要不你自己做个沙盒限制一下，避免取真实数据。"
 *
 * 沙盒规则（默认开）：
 *   · 推送目标会话的标题必须以 `[实验]` 开头（或会话 id 在 allowedSessionIds 白名单里）；
 *   · 找不到合规目标 → 不推送，返回人话原因（绝不往用户的真实会话里写）；
 *   · 推送内容只来自台账（用户自己记的待办），不含任何会话内容。
 *
 * 官方合同（本机核对）：sessionController.prompt({ requestId, sessionId, mode:'queue', content })
 */

import { randomUUID } from 'node:crypto'

export const DEFAULT_SANDBOX = {
  enabled: true,
  sessionTitlePrefix: '[实验]',
  allowedSessionIds: [],
  maxPushPerDay: 6,
}

export function createPush({ ctx, config, audit, log, store }) {
  const sandbox = { ...DEFAULT_SANDBOX, ...((config && config.sandbox) || {}) }
  const pushCfg = { enabled: true, maxItems: 3, ...((config && config.alarm && config.alarm.push) || {}) }
  const statePath = '推送状态.json'
  // 2026-10-26 修：状态以前只在内存，重启即归零（去重/日限全部失效）→ 现在走 store 落盘
  const state = store && typeof store.read === 'function'
    ? store.read(statePath, { version: 1, lastPushAt: null, pushedKeys: {}, today: null, todayCount: 0 })
    : { version: 1, lastPushAt: null, pushedKeys: {}, today: null, todayCount: 0 }
  if (!state.pushedKeys || typeof state.pushedKeys !== 'object') state.pushedKeys = {}

  function save() {
    try {
      if (store && typeof store.write === 'function') store.write(statePath, { version: 1, lastPushAt: state.lastPushAt, pushedKeys: state.pushedKeys, today: state.today, todayCount: state.todayCount })
    } catch {
      /* 存不下不影响本次推送 */
    }
  }

  function storeApi() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    } catch {
      return undefined
    }
  }

  function controller() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    } catch {
      return undefined
    }
  }

  /** 找一个"沙盒会话"：标题以 [实验] 开头，或命中白名单 */
  async function findSandboxSession() {
    if (Array.isArray(sandbox.allowedSessionIds) && sandbox.allowedSessionIds.length) {
      return { sessionId: sandbox.allowedSessionIds[0], via: 'allowlist' }
    }
    const query = storeApi()
    if (!query || typeof query.listSessions !== 'function') return null
    try {
      const records = (await query.listSessions()) || []
      const ids = records.slice(0, 80).map((r) => r && r.header && r.header.id).filter(Boolean)
      let titles = new Map()
      if (typeof query.readTitleSnapshots === 'function' && ids.length) {
        for (const item of (await query.readTitleSnapshots(ids)) || []) {
          if (item && item.status === 'fulfilled' && item.value && item.value.title) titles.set(item.sessionId, item.value.title.title || '')
        }
      }
      const prefix = String(sandbox.sessionTitlePrefix || '[实验]')
      for (const id of ids) {
        if (String(titles.get(id) || '').startsWith(prefix)) return { sessionId: id, via: 'title', title: titles.get(id) }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 推送一批提醒。
   * @param {Array<{key?:string,id?:string,title:string,due?:string}>} reminders
   */
  async function push(reminders, now = new Date(), options = {}) {
    if (!pushCfg.enabled) return { ok: false, code: 'push_disabled', message: '推送是关着的' }
    const items = (reminders || []).slice(0, Number(pushCfg.maxItems) || 3)
    if (!items.length) return { ok: false, code: 'nothing_to_push', message: '没有要推的提醒' }

    // 沙盒：必须有合规目标
    const target = await findSandboxSession()
    if (!target) {
      audit.write({ role: 'core', action: 'push:blocked', target: 'sandbox', result: 'denied', reason: 'no_sandbox_session' })
      return {
        ok: false,
        code: 'no_sandbox_session',
        message: sandbox.enabled
          ? `沙盒模式：没有找到标题以 ${sandbox.sessionTitlePrefix} 开头的会话。你先开一个「${sandbox.sessionTitlePrefix}测试」会话，我再往里推——绝不写你的真实会话。`
          : '没找到可推送的会话',
      }
    }

    const svc = controller()
    if (!svc || typeof svc.prompt !== 'function') {
      return { ok: false, code: 'no_controller', message: '这个环境不支持推送（sessionController 不可用）' }
    }

    // 去重：同一事项在"同一天"只推一次（2026-10-26 修：以前只记录不检查，等于没去重）
    const todayKey = localDate(now)
    const fresh = items.filter((item) => {
      const key = String(item.key || item.id || '')
      if (!key) return true
      const pushedDay = state.pushedKeys[key]
      return !pushedDay || String(pushedDay).slice(0, 10) !== todayKey
    })
    if (!fresh.length) {
      return { ok: false, code: 'already_pushed', message: '这些提醒今天已经推过了，不重复打扰' }
    }

    // 频率上限：每天最多 N 次
    const today = localDate(now)
    if (state.today !== today) {
      state.today = today
      state.todayCount = 0
      save()
    }
    if (state.todayCount >= (Number(sandbox.maxPushPerDay) || 6)) {
      return { ok: false, code: 'daily_limit', message: `今天推送已经到 ${sandbox.maxPushPerDay} 次上限了` }
    }

    const lines = fresh.map((item) => `· ${item.title}${item.due ? '（' + item.due + '）' : ''}`)
    const intro = options && typeof options.intro === 'string' && options.intro.trim() ? options.intro.trim() + '\n' : ''
    const text = `【dsh小助手提醒】\n${intro}${lines.join('\n')}\n\n（这是一条实验推送，目标是沙盒会话）`

    try {
      // 官方合同：prompt(request, signal) —— signal 是第二个位置参数，漏传会抛 throwIfAborted
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        await svc.prompt(
          {
            requestId: randomUUID(),
            sessionId: target.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          controller.signal,
        )
      } finally {
        clearTimeout(timer)
      }
      state.lastPushAt = now.toISOString()
      state.todayCount += 1
      for (const item of fresh) {
        if (item.key || item.id) state.pushedKeys[String(item.key || item.id)] = todayKey
      }
      // 2026-10-26 修：状态必须落盘，否则重启后今日配额/去重全归零（裁判复核抓到的漏）
      save()
      audit.write({ role: 'core', action: 'push', target: target.sessionId, result: 'ok', reason: 'items=' + fresh.length })
      if (typeof log === 'function') log('pushed ' + fresh.length + ' to ' + target.sessionId)
      return { ok: true, sessionId: target.sessionId, via: target.via, count: fresh.length }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      audit.write({ role: 'core', action: 'push', target: target.sessionId, result: 'failed', reason: message.slice(0, 120) })
      return { ok: false, code: 'push_failed', message: '推送失败：' + message }
    }
  }

  return { push, findSandboxSession, sandbox, state, statePath, save }
}

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
