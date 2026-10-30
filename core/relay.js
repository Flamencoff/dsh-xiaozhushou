/**
 * 秘书 → CEO 的“要回复”请求台账。
 *
 * 只记录用户明确要回复的请求；不向看板/浮窗暴露状态。
 * 状态：waiting（等 CEO）→ answered（已收到）→ delivered（已回传秘书）
 *       waiting → timeout（超时，内部只留痕）
 */
const FILE = '秘书/待回复.json'
const MAX_ITEMS = 100
const TIMEOUT_MS = 10 * 60 * 1000

export function createRelayStore(store, now = () => Date.now()) {
  const state = store.read(FILE, { version: 1, items: [] })
  const items = Array.isArray(state.items) ? state.items.filter(isValid) : []

  function persist() {
    return store.write(FILE, { version: 1, items: items.slice(-MAX_ITEMS) })
  }

  function nextId() {
    const n = items.reduce((max, item) => {
      const num = Number(String(item.id || '').replace(/[^0-9]/g, ''))
      return Number.isFinite(num) && num > max ? num : max
    }, 0) + 1
    return 'R-' + String(n).padStart(3, '0')
  }

  function add(input) {
    const item = {
      id: nextId(),
      requestId: input.requestId || '',
      taskId: String(input.taskId || ''),
      question: String(input.question || '').slice(0, 1200),
      ceoSessionId: String(input.ceoSessionId || ''),
      ceoBeforeSeq: Number(input.ceoBeforeSeq) || 0,
      status: 'waiting',
      askedAt: new Date(now()).toISOString(),
      answer: '',
      notifiedAt: '',
      updatedAt: new Date(now()).toISOString(),
    }
    items.push(item)
    return persist() ? { ok: true, item } : { ok: false, message: '待回复记录写不进去' }
  }

  function waiting() {
    return items.filter((item) => item.status === 'waiting')
  }

  function pending() {
    return items.filter((item) => item.status === 'waiting' || (item.status === 'answered' && !item.notifiedAt))
  }

  function find(id) {
    return items.find((item) => item.id === id)
  }

  function markAnswered(id, answer) {
    const item = find(id)
    if (!item) return { ok: false, message: '没找到待回复记录' }
    item.status = 'answered'
    item.answer = String(answer || '').slice(0, 2000)
    item.answeredAt = new Date(now()).toISOString()
    item.updatedAt = item.answeredAt
    return persist() ? { ok: true, item } : { ok: false, message: '待回复记录写不进去' }
  }

  function markDelivered(id) {
    const item = find(id)
    if (!item) return { ok: false, message: '没找到待回复记录' }
    item.status = 'delivered'
    item.notifiedAt = new Date(now()).toISOString()
    item.updatedAt = item.notifiedAt
    return persist() ? { ok: true, item } : { ok: false, message: '待回复记录写不进去' }
  }

  function markTimeout(id) {
    const item = find(id)
    if (!item) return { ok: false, message: '没找到待回复记录' }
    item.status = 'timeout'
    item.updatedAt = new Date(now()).toISOString()
    return persist() ? { ok: true, item } : { ok: false, message: '待回复记录写不进去' }
  }

  function isTimedOut(item) {
    return now() - Date.parse(item.askedAt || 0) > TIMEOUT_MS
  }

  return { add, waiting, pending, find, markAnswered, markDelivered, markTimeout, isTimedOut, list: () => items.slice() }
}

function isValid(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && typeof item.status === 'string'
}
