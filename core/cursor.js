/**
 * 游标与去重指纹（18_详细设计 §3.5；需求 R-HIS-07 / 02 §四）
 *
 * 游标：每个工作区/会话记"读到哪个 seq"，只读新增，不重读历史。
 * 指纹：同一事件不重复写进言行录（事件指纹 + 冷却），避免"同一件事被记好几遍"。
 *
 * 全部走 store（原子写 + 版本兜底），不碰宿主。
 */

const CURSOR_FILE = '记忆/游标.json'
const PRINT_FILE = '记忆/指纹.json'
const MAX_PRINTS = 2000

export function createCursor(store) {
  const cursorFile = store.read(CURSOR_FILE, { version: 1, workspaces: {} })
  const workspaces = cursorFile.workspaces && typeof cursorFile.workspaces === 'object' ? cursorFile.workspaces : {}

  const printFile = store.read(PRINT_FILE, { version: 1, seen: [] })
  const seen = new Set(Array.isArray(printFile.seen) ? printFile.seen : [])

  function get(scopeKey) {
    const entry = workspaces[scopeKey]
    return entry && typeof entry.lastSeq === 'number' ? entry.lastSeq : null
  }

  function advance(scopeKey, lastSeq, at) {
    if (!scopeKey || !Number.isFinite(Number(lastSeq))) return { ok: false, code: 'bad_input' }
    const prev = get(scopeKey)
    // 只进不退：防止并发/乱序把游标拽回去重读
    const next = prev === null ? Number(lastSeq) : Math.max(prev, Number(lastSeq))
    workspaces[scopeKey] = { lastSeq: next, at: at || new Date().toISOString() }
    store.write(CURSOR_FILE, { workspaces })
    return { ok: true, lastSeq: next, prev }
  }

  /** 事件指纹：sessionId#seq#hash。同一指纹只认一次 */
  function markSeen(fingerprint) {
    if (!fingerprint) return { ok: false, code: 'bad_input' }
    if (seen.has(fingerprint)) return { ok: true, duplicate: true }
    seen.add(fingerprint)
    const list = Array.from(seen)
    const trimmed = list.length > MAX_PRINTS ? list.slice(list.length - MAX_PRINTS) : list
    store.write(PRINT_FILE, { seen: trimmed })
    if (trimmed.length !== list.length) {
      seen.clear()
      for (const item of trimmed) seen.add(item)
    }
    return { ok: true, duplicate: false }
  }

  function hasSeen(fingerprint) {
    return seen.has(fingerprint)
  }

  function size() {
    return seen.size
  }

  return { get, advance, markSeen, hasSeen, size, workspaces }
}

/** 生成指纹：同一会话同一条事件永远同一个值 */
export function fingerprintOf(sessionId, seq, text) {
  const seed = `${sessionId || ''}#${seq || 0}#${hash(text || '')}`
  return seed
}

/** 稳定的小哈希（不追求密码学强度，只要同输入同输出） */
export function hash(text) {
  let h = 2166136261
  const str = String(text)
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
