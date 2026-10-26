/**
 * 会话事件源适配层（M3 后半）
 *
 * 职责：把官方 sessionQuery 的返回，适配成 core/read.js 需要的事件数组。
 * 这里是**唯一**真实调用宿主会话读取的地方；读的策略（档位/预算/脱敏/排除）都在 read.js。
 *
 * 用到的官方能力（本机核对）：
 *   · sessionQuery.listSessions()          → 会话列表（元数据）
 *   · sessionQuery.readTitleSnapshots(ids) → 标题
 *   · sessionQuery.readSession(sessionId)  → 完整事件日志（含 tool/call、assistant/attempt）
 *   · sessionQuery.readSurface(sessionId)  → 仅"模型可见面"事件（更省，可作省电模式）
 *
 * 只读，不写、不改、不唤醒会话。
 */

export function createSessionSource(ctx) {
  function query() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    } catch {
      return undefined
    }
  }

  async function listTargets({ limit = 50 } = {}) {
    const svc = query()
    if (!svc || typeof svc.listSessions !== 'function') {
      return { ok: false, code: 'no_session_query', message: '读不到会话列表（sessionQuery 不可用）', targets: [] }
    }
    try {
      const records = (await svc.listSessions()) || []
      const sliced = records.slice(0, limit)
      const ids = sliced.map((r) => r && r.header && r.header.id).filter(Boolean)

      const titles = new Map()
      if (ids.length && typeof svc.readTitleSnapshots === 'function') {
        try {
          for (const item of (await svc.readTitleSnapshots(ids)) || []) {
            if (item && item.status === 'fulfilled' && item.value && item.value.title) {
              titles.set(item.sessionId, item.value.title.title)
            }
          }
        } catch {
          /* 标题拿不到不影响读事件 */
        }
      }

      const targets = sliced
        .map((record) => {
          const header = (record && record.header) || {}
          return {
            sessionId: header.id,
            title: titles.get(header.id) || '',
            cwd: header.cwd || '',
            live: Boolean(record && record.live),
            createdAt: header.createdAt || null,
          }
        })
        .filter((target) => target.sessionId)

      return { ok: true, targets, total: records.length }
    } catch (error) {
      return { ok: false, code: 'list_failed', message: messageOf(error), targets: [] }
    }
  }

  /**
   * 读一个会话的事件，只返回 `seq > sinceSeq` 的部分（增量）。
   * @param {string} sessionId
   * @param {{sinceSeq?:number|null, surfaceOnly?:boolean}} options
   */
  async function readEvents(sessionId, options = {}) {
    const svc = query()
    if (!svc) return { ok: false, code: 'no_session_query', message: 'sessionQuery 不可用', events: [] }
    const sinceSeq = Number.isFinite(Number(options.sinceSeq)) ? Number(options.sinceSeq) : null

    try {
      let events = []
      if (options.surfaceOnly && typeof svc.readSurface === 'function') {
        const surface = await svc.readSurface(sessionId)
        events = (surface && surface.events) || []
      } else if (typeof svc.readSession === 'function') {
        const snapshot = await svc.readSession(sessionId)
        events = (snapshot && snapshot.events) || []
      } else if (typeof svc.readSurface === 'function') {
        const surface = await svc.readSurface(sessionId)
        events = (surface && surface.events) || []
      } else {
        return { ok: false, code: 'no_reader', message: '这个版本没有可用的会话读取接口', events: [] }
      }

      const filtered = sinceSeq === null ? events : events.filter((event) => Number(event.seq) > sinceSeq)
      return {
        ok: true,
        events: filtered.map((event) => ({ ...event, sessionId })),
        total: events.length,
        nextCursor: filtered.length ? Math.max(...filtered.map((event) => Number(event.seq) || 0)) : sinceSeq,
      }
    } catch (error) {
      return { ok: false, code: 'read_failed', message: messageOf(error), events: [] }
    }
  }

  return { listTargets, readEvents }
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}
