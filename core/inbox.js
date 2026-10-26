/**
 * 收件箱（18_详细设计 §3.2）：W 工作待办 / I 灵感 / L 生活事件 / Q 决策悬置
 *
 * 纪律：**append-only** —— 只追加、不覆盖、不删除；状态只允许 open → closed 单向变化，
 * 关闭时记 closedAt（这是"不改历史、只记事实"的落点）。
 */

const FILE = '收件箱.json'
const TYPES = ['W', 'I', 'L', 'Q']

export function createInbox(store) {
  const file = store.read(FILE, { version: 1, items: [] })
  const items = Array.isArray(file.items) ? file.items.filter(isValid) : []
  const skipped = Array.isArray(file.items) ? file.items.length - items.length : 0
  let seq = items.reduce((max, item) => {
    const n = Number(String(item.id).replace(/[^0-9]/g, ''))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)

  function persist() {
    return store.write(FILE, { items, skipped })
  }

  function add(input) {
    const title = String((input && input.title) || '').trim()
    if (!title) return fail('empty_title', '收件箱条目要有内容')
    const type = TYPES.includes(input.type) ? input.type : 'W'
    seq += 1
    const item = {
      id: `I-${String(seq).padStart(3, '0')}`,
      type,
      title: title.slice(0, 200),
      status: 'open',
      due: input.due || null,
      estimate_slots: Number.isFinite(Number(input.estimate_slots)) ? Number(input.estimate_slots) : null,
      source_session: input.source_session || null,
      detail: String(input.detail || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    }
    items.push(item)
    persist()
    return { ok: true, item }
  }

  /** 关闭（不删除）：只允许 open → closed，重复关闭返回 bad_transition */
  function close(id) {
    const item = items.find((entry) => entry.id === id)
    if (!item) return fail('not_found', `没找到 ${id}`)
    if (item.status === 'closed') return fail('bad_transition', `${id} 已经关闭过了`)
    item.status = 'closed'
    item.closedAt = new Date().toISOString()
    persist()
    return { ok: true, item }
  }

  function list(filter = {}) {
    const type = filter.type
    const status = filter.status
    return items
      .filter((item) => (type ? item.type === type : true))
      .filter((item) => (status ? item.status === status : true))
  }

  return { add, close, list, TYPES, skipped }
}

function fail(code, message) {
  return { ok: false, code, message }
}

function isValid(item) {
  return Boolean(
    item &&
      typeof item.id === 'string' &&
      /^I-\d{3,}$/.test(item.id) &&
      typeof item.title === 'string' &&
      TYPES.includes(item.type) &&
      (item.status === 'open' || item.status === 'closed'),
  )
}
