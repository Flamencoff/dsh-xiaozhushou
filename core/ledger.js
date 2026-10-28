/**
 * 台账：待办与状态机（18_详细设计 §2.1 / §4）
 *
 * 状态：候选 → 已确认 → 已完成
 *        候选/已确认 → 已忽略
 * 只有「已确认」才可能触发提醒（R-ALM-01）。
 * 变更权归 CEO（会话）或用户经面板指令；秘书只能 add（R-DAT-02）。
 */

const STATUS = { CANDIDATE: '候选', CONFIRMED: '已确认', PAUSED: '已暂停', DONE: '已完成', DROPPED: '已忽略' }

const ALLOWED = {
  候选: ['已确认', '已忽略', '已暂停'],
  已确认: ['已完成', '已忽略', '已暂停'],
  已暂停: ['已确认', '已忽略'],
  已完成: [],
  已忽略: [],
}

const FILE = '待办.json'

export function createLedger(store) {
  const file = store.read(FILE, { version: 1, items: [], skipped: 0 })
  const items = Array.isArray(file.items) ? file.items.filter(isValid) : []
  const skipped = Array.isArray(file.items) ? file.items.length - items.length : 0
  let seq = items.reduce((max, item) => {
    const n = Number(String(item.id).replace(/[^0-9]/g, ''))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)

  function persist() {
    return store.write(FILE, { items, skipped })
  }

  function find(id) {
    return items.find((item) => item.id === id)
  }

  function add(input) {
    const title = String(input && input.title ? input.title : '').trim()
    if (!title) return fail('empty_title', '待办得有个名字，比如"把附件补齐"')
    // 2026-10-26 修 A-13：日期看不懂时以前静默存 null（用户以为记上了，实际永远不会提醒）。
    if (input && input.due !== undefined && input.due !== null && String(input.due).trim()) {
      const parsed = normalizeDate(input.due)
      if (!parsed) {
        return fail('invalid_due', '这个日期我没看懂：用 2026-10-30 这种写法，或者说 今天 / 明天 / 后天')
      }
    }
    if (title.length > 120) return fail('title_too_long', '名字太长了，压到 120 字以内')

    seq += 1
    const item = {
      id: `T-${String(seq).padStart(3, '0')}`,
      title,
      status: STATUS.CANDIDATE,
      urgency: clampLevel(input.urgency),
      importance: clampLevel(input.importance),
      mostUrgent: Boolean(input.mostUrgent),
      mostImportant: Boolean(input.mostImportant),
      due: normalizeDate(input.due),
      estimate_slots: Number.isFinite(Number(input.estimate_slots)) ? Math.max(1, Math.min(20, Number(input.estimate_slots))) : null,
      due_source: input.due_source === 'estimated' ? 'estimated' : 'author',
      source: input.source || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    items.push(item)
    // 2026-10-26 修：写盘失败以前也回 ok:true，界面说"已记录"，重启后消失
    if (!persist()) {
      items.pop()
      return fail('write_failed', '写不进去（磁盘满/只读/文件被占用），这次没记下')
    }
    return { ok: true, item }
  }

  function transition(id, next, patch) {
    const item = find(id)
    if (!item) return fail('not_found', `没找到 ${id}，可能记错编号了`)
    if (!ALLOWED[item.status] || !ALLOWED[item.status].includes(next)) {
      return fail('bad_transition', `这条待办现在是「${item.status}」，不能改成「${next}」`)
    }
    const before = { ...item }
    Object.assign(item, patch || {}, { status: next, updatedAt: new Date().toISOString() })
    if (!persist()) {
      Object.assign(item, before)
      return fail('write_failed', '写不进去（磁盘满/只读/文件被占用），状态没变')
    }
    return { ok: true, item }
  }

  function confirm(id, input = {}) {
    const patch = {}
    if (input.due !== undefined && input.due !== null && String(input.due).trim()) {
      const parsed = normalizeDate(input.due)
      if (!parsed) return fail('invalid_due', '这个日期我没看懂：用 2026-10-30 这种写法，或者说 今天 / 明天 / 后天')
      patch.due = parsed
    }
    // FIX-04：记下用户说过的时刻（只作记录；定点提醒仍是 08:05/12:05/18:05）
    if (input.dueTime !== undefined && input.dueTime !== null && String(input.dueTime).trim()) patch.dueTime = String(input.dueTime).trim()
    if (input.estimate_slots !== undefined) patch.estimate_slots = Math.max(1, Math.min(20, Number(input.estimate_slots) || 1))
    if (input.due_source === 'estimated' || input.due_source === 'author') patch.due_source = input.due_source
    if (input.urgency !== undefined) patch.urgency = clampLevel(input.urgency)
    if (input.importance !== undefined) patch.importance = clampLevel(input.importance)
    if (input.mostUrgent !== undefined) patch.mostUrgent = Boolean(input.mostUrgent)
    if (input.mostImportant !== undefined) patch.mostImportant = Boolean(input.mostImportant)
    return transition(id, STATUS.CONFIRMED, patch)
  }

  // 2026-10-26 新增：改标题/日期（只允许候选与已确认）
  function edit(id, input = {}) {
    const item = find(id)
    if (!item) return fail('not_found', '没找到 ' + id + '，可能记错编号了')
    if (item.status !== STATUS.CANDIDATE && item.status !== STATUS.CONFIRMED) {
      return fail('bad_state', '这条待办现在是「' + item.status + '」，不能再改')
    }
    const patch = {}
    if (input.title !== undefined) {
      const title = String(input.title || '').trim()
      if (!title) return fail('empty_title', '标题不能是空的')
      if (title.length > 120) return fail('title_too_long', '名字太长了，压到 120 字以内')
      patch.title = title
    }
    if (input.due !== undefined) {
      const text = String(input.due || '').trim()
      if (!text) patch.due = null
      else {
        const parsed = normalizeDate(text)
        if (!parsed) return fail('invalid_due', '这个日期我没看懂：用 2026-10-30 这种写法，或者说 今天 / 明天 / 后天')
        patch.due = parsed
      }
    }
    if (!Object.keys(patch).length) return fail('no_change', '没给要改的内容')
    patch.updatedAt = new Date().toISOString()
    const before = { ...item }
    Object.assign(item, patch)
    if (!persist()) {
      Object.assign(item, before)
      return fail('write_failed', '写不进去（磁盘满/只读/文件被占用），没改成')
    }
    return { ok: true, item }
  }

  function drop(id) {
    return transition(id, STATUS.DROPPED)
  }

  function pause(id) {
    return transition(id, STATUS.PAUSED)
  }

  function resume(id) {
    return transition(id, STATUS.CONFIRMED)
  }

  function adjust(id, input = {}) {
    const item = find(id)
    if (!item) return fail('not_found', '没找到 ' + id + '，可能记错编号了')
    if (!['候选', '已确认', '已暂停'].includes(item.status)) return fail('bad_state', '这条待办现在的状态不能调整')
    const patch = {}
    if (input.urgency !== undefined) patch.urgency = clampLevel(input.urgency)
    if (input.importance !== undefined) patch.importance = clampLevel(input.importance)
    if (!Object.keys(patch).length) return fail('no_change', '没给要调整的层级')
    patch.updatedAt = new Date().toISOString()
    const before = { ...item }
    Object.assign(item, patch)
    if (!persist()) {
      Object.assign(item, before)
      return fail('write_failed', '写不进去（磁盘满/只读/文件被占用），没调整')
    }
    return { ok: true, item }
  }

  function doneAt(now) {
    const d = now || new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  function done(id) {
    return transition(id, STATUS.DONE, { completedAt: new Date().toISOString() })
  }

  function list(filter = {}) {
    const status = filter.status
    return items.filter((item) => (status ? item.status === status : true))
  }

  // 每周归档：方便做周报
  // 把「已完成 / 已忽略」且最后更新超过 7 天的条目写成一份人读 md：
  //   台账归档\<年>-W<周>.md
  // 然后从主台账移除；主台账只留活跃项。归档文件只追加、不改。
  function archiveWeek(now = new Date(), keepDays = 7) {
    const week = isoWeek(now)
    const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
    const out = []
    const keep = []
    for (const item of items) {
      const finished = item.status === STATUS.DONE || item.status === STATUS.DROPPED
      const at = Date.parse(item.updatedAt || item.createdAt || '')
      if (finished && Number.isFinite(at) && at < cutoff) out.push(item)
      else keep.push(item)
    }
    if (!out.length) return { ok: true, archived: 0, week }

    const lines = [
      '# 台账归档 · ' + week,
      '',
      '> 由 dsh小助手每周自动归档：已完成 / 已忽略且超过 ' + keepDays + ' 天没动的条目。',
      '> 主台账只留活跃项；本文件只追加、不改。',
      '',
      '| 编号 | 标题 | 状态 | 截止 | 最后更新 |',
      '|---|---|---|---|---|',
      ...out.map((item) => '| ' + item.id + ' | ' + String(item.title).replace(/\|/g, '\\|') + ' | ' + item.status + ' | ' + (item.due || '') + ' | ' + String(item.updatedAt || item.createdAt || '').slice(0, 10) + ' |'),
      '',
    ]
    const ok = store.appendText('台账归档/' + week + '.md', lines.join('\n'))
    if (!ok) return { ok: false, code: 'archive_failed', message: '归档文件写不进去（主台账没动）', week }

    items.length = 0
    for (const item of keep) items.push(item)
    if (!persist()) return { ok: false, code: 'write_failed', message: '归档写好了，但主台账没写进去，请重试', week }
    return { ok: true, archived: out.length, week, ids: out.map((item) => item.id) }
  }

  function isoWeek(now) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    const day = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() + 4 - day)
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
    return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
  }

  function stats() {
    const confirmed = items.filter((item) => item.status === STATUS.CONFIRMED)
    return {
      confirmed: confirmed.sort(byDue),
    // 待确认清单（只给标题用；CEO 的四问需要知道"有哪些事悬着"）
    pending: items.filter((item) => item.status === STATUS.CANDIDATE).sort(byDue),
      pendingCount: items.filter((item) => item.status === STATUS.CANDIDATE).length,
      pausedCount: items.filter((item) => item.status === STATUS.PAUSED).length,
      paused: items.filter((item) => item.status === STATUS.PAUSED).sort(byDue),
      doneCount: items.filter((item) => item.status === STATUS.DONE).length,
      // FIX-06：只算今天完成的（以前拿累计数说'今天完成'
      doneToday: items.filter((item) => item.status === STATUS.DONE && String(item.completedAt || item.updatedAt || '').slice(0, 10) === doneAt()).length,
      droppedCount: items.filter((item) => item.status === STATUS.DROPPED).length,
      skipped,
    }
  }

  return { add, confirm, drop, pause, resume, adjust, done, edit, list, find, stats, archiveWeek, STATUS }
}

/* ── 小工具 ─────────────────────────────────────────────── */

function fail(code, message) {
  return { ok: false, code, message }
}

function isValid(item) {
  return Boolean(item && typeof item.id === 'string' && /^T-\d{3,}$/.test(item.id) && typeof item.title === 'string' && ALLOWED[item.status])
}

function clampLevel(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(3, Math.max(1, Math.round(n)))
}

function normalizeDate(value) {
  if (!value) return null
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const today = new Date()
  if (text === '今天' || text === 'today') return isoDate(today)
  if (text === '明天' || text === 'tomorrow') return isoDate(new Date(today.getTime() + 86400000))
  if (text === '后天') return isoDate(new Date(today.getTime() + 2 * 86400000))
  // 2026-10-26 修 A-13：以前任意字符串原样存下，提醒永远不匹配、也不报错。
  // 现在只收 YYYY-MM-DD / 今天 / 明天 / 后天，其它一律 null（表示"没定日期"）。
  return null
}

function isoDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function byDue(a, b) {
  const da = a.due || '9999-99-99'
  const db = b.due || '9999-99-99'
  return da < db ? -1 : da > db ? 1 : 0
}
