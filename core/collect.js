/**
 * 会话元数据采集（R-DAT-05）
 *
 * 只做「只读、元数据级」：会话 id、标题、工作目录、是否在跑、创建时间。
 * **不读消息内容**——读内容是史官的事（M3，按档位与预算），两者故意解耦。
 *
 * 官方能力：sessionQuery.listSessions() / readTitleSnapshots(ids)
 */

const FILE = '采集.json'
const MAX_SESSIONS = 80
// 标题快照只取最近 N 个：启动时少读一半以上，肉眼可见地快
const MAX_TITLES = 20

export async function collect(ctx, store, logger) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (!query || typeof query.listSessions !== 'function') {
    return { ok: false, code: 'no_session_query', message: '读不到会话列表（sessionQuery 不可用）', sessions: [] }
  }

  try {
    const records = await query.listSessions()
    const sliced = Array.isArray(records) ? records.slice(0, MAX_SESSIONS) : []
    const ids = sliced.map((r) => r.header && r.header.id).filter(Boolean).slice(0, MAX_TITLES)

    let titles = new Map()
    if (ids.length && typeof query.readTitleSnapshots === 'function') {
      try {
        const results = await query.readTitleSnapshots(ids)
        for (const r of results || []) {
          if (r && r.status === 'fulfilled' && r.value && r.value.title) {
            titles.set(r.sessionId, r.value.title.title)
          }
        }
      } catch {
        /* 标题拿不到不影响主流程 */
      }
    }

    const sessions = sliced
      .map((r) => {
        const header = r.header || {}
        return {
          id: header.id,
          title: titles.get(header.id) || '',
          cwd: header.cwd || '',
          live: Boolean(r.live),
          agentPreset: header.agentPreset || '',
          createdAt: header.createdAt || null,
        }
      })
      .filter((s) => s.id)

    const snapshot = {
      ok: true,
      at: new Date().toISOString(),
      total: Array.isArray(records) ? records.length : sessions.length,
      truncated: Array.isArray(records) ? records.length > MAX_SESSIONS : false,
      sessions,
    }
    store.write(FILE, snapshot)
    return snapshot
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (logger) logger('collect failed: ' + message)
    return { ok: false, code: 'collect_failed', message, sessions: [] }
  }
}
