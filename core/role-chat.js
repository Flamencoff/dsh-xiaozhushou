/**
 * 角色聊天（秘书 / CEO / 史官）——**只走绑定的真实会话**，没有"模型兜底"（框架 v2 · D-01）。
 *
 * 设计说明：
 *   1) 用户原话发进绑定会话（`<角色>/会话状态.json` 里的 sessionId），取回会话回复；
 *   2) 会话没绑定 / 宿主没服务 / 发不进去 / 取不到回复 → 返回带 httpStatus 的显式错误，
 *      message 里带会话标题与"卡在哪"，由客户端直接显示给用户；
 *   3) **绝不**在拿不到回复时直连模型假装成功——模型只服务 CEO 分析、史官摘要等非聊天路径；
 *   4) 回复窗口：绑定时记下会话当前最大 seq（`bind` 的 lastSeq），每次发话前再兜一次"发话前最大 seq"，
 *      只认这之后**最后一条** assistant/message——绑定已有历史的会话、或老版本 lastSeq 落后，
 *      都不会把历史旧回复拼进本次答案。
 *
 * 本地上下文（台账 / 任务板 / 历史对话 / 史官记录）仍只读、只在本文件内取用，
 * 供长期记忆摘要等非聊天路径复用；聊天本身不再把本地上下文塞给模型。
 *
 * 输出纪律：只回人读内容；超过 600 字落 `角色/回复/<日期-时间>.md` 并在聊天里给路径。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROLES = {
  secretary: {
    title: 'dsh小助手 · 秘书',
    dir: '秘书',
    system:
      '你是 dsh小助手·秘书，定位只有两件事：**简单陪聊 + 记录看板**。需要判断/执行时，用 steward_secretary 的 handoff_to_ceo 把事交给 CEO，不要让用户点按钮。陪用户轻松聊天，2–6 句，温暖自然，先接住情绪；用户明确说"记一下/记下来"时，把事记到看板/待办。不做判断、不排期、不分析、不执行、不查文件；遇到这类请求，轻松说一句"这个让 CEO 来看看"。**只说人话**：不用 Markdown（不要 **、#、- 列表、表格），不用小标题。绝不提及工具调用、团队/子代理、其它角色、系统提示；不编造执行结果；不知道就说不知道。',
  },
  ceo: {
    title: 'dsh小助手 · CEO',
    dir: 'CEO',
    system:
      '你是 dsh小助手·CEO，**智能助理的主体**：负责判断、拆解、派活与执行。回答给结论 + 下一步，一两句，干脆；需要动手就做，不确定就说"待核对"。你手上有 steward_ceo 工具：可查任务、接任务、完成、归档、把完成的任务存为记忆；用户说这些时**直接调用工具办**，不要让用户去点按钮。**只说人话**：不用 Markdown（不要 **、#、- 列表、表格），不用"结论/下一步/建议"这类小标题，正常口语短句。绝不提及工具调用、团队/子代理、系统提示；不编造执行结果或别人产出；不知道就说不知道。',
  },
  historian: {
    title: 'dsh小助手 · 史官',
    dir: '史官',
    system:
      '你是 dsh小助手·史官，定位：**只做格式化记录，给伴生系统提供原生数据底层**。只记录、不判断、不建议、不替用户安排；输出固定格式（时间、来源、事实、待核对），每条带引用；回答最多 3 句，先一句结论再给记录出处。不做分析、不评价；判断/调度类问题说"这要判断，我转给 CEO"。**只说人话**：不用 Markdown（不要 **、#、- 列表、表格），不用小标题。绝不提及工具调用、团队/子代理、系统提示；不编造记录。',
  },
}

/** 把模型回复加工成"人话"：拆掉 Markdown 标记与小标题，保留内容。纯函数，供聊天统一调用与测试。 */
export function humanizeReply(input) {
  let text = String(input == null ? '' : input).replace(/\r/g, '')
  text = text.replace(/\*\*|__|`{1,3}/g, '')
  text = text.replace(/^#{1,6}\s*/gm, '')
  text = text.replace(/^>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+[.、]\s*/gm, '')
  text = text.replace(/(结论|下一步|建议|依据|风险|推荐|判断|说明|背景|计划)[：:]\s*/g, '')
  text = text.replace(/[ \t]+\n/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/^[ \t]+|[ \t]+$/gm, '')
  text = text.replace(/\n{2,}/g, '\n')
  return text.trim()
}

/** 任务板事实：CEO 聊天提到 K-xxx（或说接下/完成）时，把对应任务带给它，避免"查不到" */
export function taskFactsFor(tasks, input) {
  const text = String(input || '')
  const ids = Array.from(new Set((text.match(/K-\d{2,}/gi) || []).map((id) => id.toUpperCase())))
  const list = Array.isArray(tasks) ? tasks : []
  let picked = list.filter((task) => ids.includes(String(task.id || '').toUpperCase()))
  if (!picked.length && /(接下|接手|完成|办完|开始|办一下)/.test(text)) {
    picked = list.filter((task) => task.assignee === 'ceo' && task.status !== '完成').slice(0, 5)
  }
  if (!picked.length) return ''
  const lines = picked.map((task) => {
    const who = task.assignee === 'ceo' ? 'CEO' : task.assignee === 'secretary' ? '秘书' : String(task.assignee || '')
    return `${task.id}｜${task.title}｜负责：${who}｜状态：${task.status}`
  })
  return '【任务板事实（本地 任务.json，以此为准）】\n' + lines.join('\n')
}

// 每个角色在 DSH 里的真实会话标题（建好会话时由 /roles/bootstrap 写进会话状态）
const DEFAULT_TITLES = {
  secretary: 'dsh小助手 · 秘书 对话',
  ceo: 'dsh小助手 · CEO 对话',
  historian: 'dsh小助手 · 史官 对话',
}

export function createRoleChat({ ctx, store, log, role, ledger, dataDir, timing, memory }) {
  // 时间参数留成可注入：默认 30s 发送超时 / 90s 等回复 / 1s 轮询；测试用小值，不改成另一套逻辑
  const promptTimeoutMs = Number(timing && timing.promptTimeoutMs) || 30_000
  const replyTimeoutMs = Number(timing && timing.replyTimeoutMs) || 90_000
  const pollMs = Number(timing && timing.pollMs) || 1000
  const conf = ROLES[role]
  if (!conf) throw new Error('unknown role: ' + role)
  const logFn = typeof log === 'function' ? log : () => {}
  const historianRoot = dataDir ? join(dirname(dataDir), '史官') : ''

  function localDay() {
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  function tailFile(file, max) {
    try {
      if (!existsSync(file)) return ''
      return readFileSync(file, 'utf8').slice(-max)
    } catch {
      return ''
    }
  }

  function recentRoleDialog() {
    return tailFile(join(dataDir || '', conf.dir, '对话', localDay() + '.md'), 1200)
  }

  function recentSecretaryDialog() {
    if (role === 'secretary') return ''
    return tailFile(join(dataDir || '', '秘书', '对话', localDay() + '.md'), 1200)
  }

  function latestHistorianRaw() {
    try {
      if (!historianRoot) return ''
      const root = join(historianRoot, '言行录')
      if (!existsSync(root)) return ''
      const months = readdirSync(root).sort().slice(-1)
      let text = ''
      for (const month of months) {
        for (const file of readdirSync(join(root, month)).sort().slice(-1)) {
          text = tailFile(join(root, month, file), 2500)
        }
      }
      return text
    } catch {
      return ''
    }
  }

  function recentHistorianRecords() {
    if (role === 'historian') return ''
    try {
      if (!historianRoot || !existsSync(historianRoot)) return ''
      const root = join(historianRoot, '言行录')
      if (!existsSync(root)) return ''
      const months = readdirSync(root).sort().slice(-2)
      let text = ''
      for (const month of months) {
        const dir = join(root, month)
        for (const file of readdirSync(dir).sort().slice(-3)) text += tailFile(join(dir, file), 1500) + '\n'
      }
      return text.slice(-2500)
    } catch {
      return ''
    }
  }

  const TASKS_FILE = '任务.json'

  function readTasks() {
    try {
      const data = store.read(TASKS_FILE, { version: 1, tasks: [] }) || { version: 1, tasks: [] }
      return Array.isArray(data.tasks) ? data.tasks : []
    } catch {
      return []
    }
  }

  function saveTasks(tasks) {
    try {
      store.write(TASKS_FILE, { version: 1, tasks })
      return true
    } catch {
      return false
    }
  }

  function nextTaskId(tasks) {
    let max = 0
    for (const task of tasks) {
      const n = Number(String(task.id || '').replace(/[^0-9]/g, ''))
      if (n > max) max = n
    }
    return 'K-' + String(max + 1).padStart(3, '0')
  }

  /** 给别的角色派活（秘书→CEO / 用户→CEO）；派给 CEO 的任务自动进入"进行中"（作者要求自动接） */
  function assignTask({ title, assignee = 'ceo', by = role, facts = '' }) {
    const text = String(title || '').trim()
    if (!text) return { ok: false, code: 'empty', message: '任务没写清楚' }
    const tasks = readTasks()
    const now = new Date().toISOString()
    const autoAcceptCeo = assignee === 'ceo'
    const task = {
      id: nextTaskId(tasks),
      title: text,
      assignee,
      by,
      status: autoAcceptCeo ? '进行中' : '待办',
      facts: String(facts || '').slice(0, 1200),
      createdAt: now,
      updatedAt: now,
      ...(autoAcceptCeo ? { autoAccepted: true, acceptedAt: now } : {}),
    }
    tasks.push(task)
    if (!saveTasks(tasks)) return { ok: false, code: 'write_failed', message: '任务板写不进去' }
    return { ok: true, task }
  }

  /** 硬动作：改状态；可带 assignee 做"转交"（D-20 ①） */
  function setTaskStatus(id, status, options = {}) {
    const tasks = readTasks()
    const task = tasks.find((item) => item.id === id)
    if (!task) return { ok: false, code: 'not_found', message: '没找到 ' + id }
    task.status = status
    const assignee = options && typeof options.assignee === 'string' ? options.assignee.trim() : ''
    if (assignee) {
      task.assignee = assignee
      task.by = 'user'
    }
    task.updatedAt = new Date().toISOString()
    if (!saveTasks(tasks)) return { ok: false, code: 'write_failed', message: '任务板写不进去' }
    return { ok: true, task }
  }

  function tasksBrief() {
    const tasks = readTasks()
    const open = tasks.filter((task) => task.status !== '完成')
    if (!open.length) return ''
    const fmt = (task) => task.id + '｜' + task.title + '｜负责：' + (task.assignee === 'ceo' ? 'CEO' : task.assignee === 'secretary' ? '秘书' : task.assignee) + '｜状态：' + task.status + '｜来自：' + task.by + (task.facts ? '｜事实底稿：' + task.facts.slice(0, 500) : '')
    return open.slice(-10).map(fmt).join(String.fromCharCode(10))
  }

  function todosBrief() {
    try {
      if (!ledger || typeof ledger.stats !== 'function') return ''
      const stats = ledger.stats()
      const fmt = (item) => item.id + ' ' + item.title + (item.due ? '（' + item.due + '）' : '')
      const lines = []
      lines.push('已确认 ' + stats.confirmed.length + ' 条：' + stats.confirmed.slice(0, 6).map(fmt).join('；'))
      if (stats.pending && stats.pending.length) lines.push('待确认 ' + stats.pendingCount + ' 条：' + stats.pending.slice(0, 6).map(fmt).join('；'))
      return lines.join('\n')
    } catch {
      return ''
    }
  }

  function get(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  function localState() {
    try {
      return store.read(conf.dir + '/会话状态.json', { version: 1, sessionId: null, lastSeq: 0 }) || { sessionId: null, lastSeq: 0 }
    } catch {
      return { sessionId: null, lastSeq: 0 }
    }
  }

  function sessionTitleOf(state) {
    const title = state && typeof state.title === 'string' ? state.title.trim() : ''
    return title || DEFAULT_TITLES[role] || conf.title
  }

  /**
   * 绑定一个真实会话（按钮/接口用；不绑定就不聊天）。
   * 绑定点要记下"当前最大 seq"：会话可能已经有历史（用户绑一个聊过的会话，
   * 或老版本 会话状态.json 的 lastSeq 落后），聊天只认**绑定之后**新产生的回复。
   */
  async function bind(sessionId, title) {
    const id = String(sessionId || '').trim()
    if (!id) return { ok: false, code: 'empty_session', message: '给个会话 id' }
    const wanted = String(title || '').trim() || DEFAULT_TITLES[role] || conf.title
    let lastSeq = 0
    const query = get('sessionQuery')
    if (query && typeof query.readSession === 'function') {
      try {
        const raw = await query.readSession(id)
        lastSeq = maxSeqOf((raw && raw.events) || [])
      } catch {
        lastSeq = 0 // 读不到就按 0；聊天时还会再兜一次"发话前最大 seq"
      }
    }
    try {
      store.write(conf.dir + '/会话状态.json', { version: 1, sessionId: id, lastSeq, title: wanted, boundBy: 'bind', updatedAt: new Date().toISOString() })
    } catch {
      return { ok: false, code: 'write_failed', message: '会话状态写不进去（数据目录不可写？）' }
    }
    return { ok: true, sessionId: id, title: wanted, lastSeq }
  }

  function maxSeqOf(events) {
    let max = 0
    for (const event of Array.isArray(events) ? events : []) {
      const seq = Number(event && event.seq)
      if (Number.isFinite(seq) && seq > max) max = seq
    }
    return max
  }

  /**
   * 这批事件里**最后一条** assistant/message 的文本（只认 seq > afterSeq）。
   * 返回 { seq, text } 或 null；绝不把多条历史回复拼在一起。
   */
  function latestAssistantText(events, afterSeq) {
    let pick = null
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || event.type !== 'assistant/message') continue
      const seq = Number(event.seq)
      if (!Number.isFinite(seq) || seq <= afterSeq) continue
      const msg = (event.data && event.data.message) || event.message
      if (!msg || msg.role !== 'assistant') continue
      const text = (msg.content || [])
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
        .trim()
      if (text) pick = { seq, text }
    }
    return pick
  }

  function timeoutLabel(ms) {
    return ms >= 1000 ? Math.round(ms / 1000) + ' 秒' : ms + ' 毫秒'
  }

  /** 会话不可用时的统一错误：带标题 + 卡在哪 + httpStatus，由路由透传给客户端 */
  function sessionFailure(state, stage, code, httpStatus, detail) {
    const title = sessionTitleOf(state)
    const where = state && state.sessionId ? title + '（会话 ' + state.sessionId + '）' : title
    return {
      ok: false,
      code,
      httpStatus,
      sessionRequired: true,
      sessionId: (state && state.sessionId) || null,
      sessionTitle: title,
      stage,
      message: '会话不可用（卡在：' + stage + '）——' + where + (detail ? '：' + detail : ''),
    }
  }

  /**
   * 把用户原话发进绑定会话，取回会话回复。
   * 失败一律返回 ok:false + httpStatus + message（不抛、不兜底模型）。
   */
  async function sessionChat(promptText) {
    const controller = get('sessionController')
    const query = get('sessionQuery')
    const state = localState()
    if (!state.sessionId) {
      return sessionFailure(state, '还没绑定这个角色的真实会话', 'no_session', 409, '先把角色会话建好并绑定，再来聊天')
    }
    if (!controller || typeof controller.prompt !== 'function') {
      return sessionFailure(state, '宿主没提供会话服务（sessionController.prompt 不可用）', 'no_controller', 503, '重启 DSH 再试')
    }
    if (!query || typeof query.readSession !== 'function') {
      return sessionFailure(state, '读不到会话回复（sessionQuery.readSession 不可用）', 'no_query', 503, '重启 DSH 再试')
    }
    // 绑定点兜底：发话前先取一次会话当前最大 seq，只认之后新产生的回复。
    // 这样绑定一个已有历史的会话、或老版本 lastSeq 落后时，都不会把历史旧回复当本次答案。
    let sinceSeq = Number(state.lastSeq) || 0
    try {
      const before = await query.readSession(state.sessionId)
      const beforeMax = maxSeqOf((before && before.events) || [])
      if (beforeMax > sinceSeq) sinceSeq = beforeMax
    } catch {
      /* 读不到就按存量 lastSeq；poll 时仍然只取最新一条 */
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), promptTimeoutMs)
    try {
      await controller.prompt({ requestId: requireId(), sessionId: state.sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }, abort.signal)
    } catch (error) {
      return sessionFailure(state, '把话发进会话时失败', 'prompt_failed', 502, String(error && error.message ? error.message : error))
    } finally {
      clearTimeout(timer)
    }
    const deadline = Date.now() + replyTimeoutMs
    let answer = ''
    let replySeq = null
    let nextSeq = sinceSeq
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      try {
        const raw = await query.readSession(state.sessionId)
        const events = (raw && raw.events) || []
        const maxSeq = maxSeqOf(events)
        if (maxSeq > nextSeq) nextSeq = maxSeq
        const latest = latestAssistantText(events, sinceSeq)
        if (latest) {
          answer = latest.text
          replySeq = latest.seq
          break
        }
      } catch {
        /* 继续等 */
      }
    }
    if (!answer) {
      return sessionFailure(state, '会话 ' + timeoutLabel(replyTimeoutMs) + '内没回话（可能它还在跑，或它自己报错了）', 'no_reply', 504, '去会话里看它停在哪')
    }
    try {
      store.write(conf.dir + '/会话状态.json', { version: 1, sessionId: state.sessionId, lastSeq: nextSeq, title: sessionTitleOf(state), updatedAt: new Date().toISOString() })
    } catch {
      /* 游标写不进去不影响本次回复；下次会重读旧 seq */
    }
    return { ok: true, text: answer, sessionId: state.sessionId, sessionTitle: sessionTitleOf(state), replySeq, lastSeq: nextSeq }
  }

  function requireId() {
    return 'role-' + role + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000)
  }

  /**
   * D-19：秘书/CEO 的会话消息前面带一段**长期记忆摘要**（≤420 字、只取片段）。
   * 用户原话一字不改地保留在 `【用户说】` 后面；史官不读记忆。
   */
  function messageWithMemory(text) {
    // 角色规则随每条消息再声明一次：即使 preset 身份段没注册上，也不让会话退回"通用 Agent"口气
    let facts = ''
    if (role === 'ceo') {
      try {
        facts = taskFactsFor(readTasks(), text)
      } catch {
        facts = ''
      }
    }
    const head = '【本角色规则·必须遵守】\n' + conf.system + '\n\n' + (facts ? facts + '\n\n' : '')
    if (!memory || role === 'historian' || typeof memory.summaryFor !== 'function') return head + '【用户说】' + text
    let card = ''
    try {
      card = String(memory.summaryFor(role, { maxChars: 420 }) || '').trim()
    } catch {
      card = ''
    }
    if (!card) return head + '【用户说】' + text
    return head + '【长期记忆摘要（本地 记忆/ 文件，可能过期，仅供参考）】\n' + card + '\n\n【用户说】' + text
  }

  async function chat(question) {
    const text = String(question || '').trim()
    if (!text) return { ok: false, code: 'empty_question', httpStatus: 400, message: '说点什么吧' }

    // D-01：聊天只有一条路——绑定会话。拿不到回复就报错，不直连模型、不假装成功。
    const viaSession = await sessionChat(messageWithMemory(text))
    if (!viaSession.ok) return viaSession
    // 聊天只说人话：统一拆掉 Markdown 与小标题（三个角色一致）
    const cleaned = humanizeReply(viaSession.text)
    if (cleaned) viaSession.text = cleaned
    const answer = { ok: true, text: viaSession.text }

    let shown = answer.text
    let docPath = null
    // 史官默认短回答：超过 300 字只给摘要 + 文档路径
    if (role === 'historian' && shown.length > 300) {
      try {
        const now = new Date()
        const stamp = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0')
        docPath = conf.dir + '/回复/' + localDay() + '-' + stamp + '.md'
        store.appendText(docPath, '# ' + conf.title + ' · ' + localDay() + ' ' + stamp + '\n\n**问**：' + text + '\n\n**答**：\n\n' + shown + '\n')
        shown = shown.slice(0, 240).trim() + '\n\n（要展开说一声，全文：' + docPath + '）'
      } catch {
        /* 落盘失败就照原样 */
      }
    }
    if (shown.length > 600) {
      try {
        const now = new Date()
        const stamp = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0')
        docPath = conf.dir + '/回复/' + localDay() + '-' + stamp + '.md'
        store.appendText(docPath, '# ' + conf.title + ' · ' + localDay() + ' ' + stamp + '\n\n**问**：' + text + '\n\n**答**：\n\n' + shown + '\n')
        shown = shown.slice(0, 200).trim() + '\n\n（完整内容我写成文档了：' + docPath + '）'
      } catch {
        docPath = null
        shown = answer.text
      }
    }

    try {
      const clock = new Date()
      const hh = String(clock.getHours()).padStart(2, '0')
      const mm = String(clock.getMinutes()).padStart(2, '0')
      store.appendText(conf.dir + '/对话/' + localDay() + '.md', '\n## ' + hh + ':' + mm + '\n\n**我**：' + text + '\n\n**' + conf.title + '**：' + answer.text + '\n')
    } catch {
      /* 归档失败不影响聊天 */
    }

    return { ok: true, source: 'session', role, text: shown, docPath, sessionId: viaSession.sessionId || null, sessionTitle: viaSession.sessionTitle || null }
  }

  /** 把系统记录写进真实会话（不等待回复）：让"接下/完成/归档/存为记忆"在会话里可见 */
  function notice(text) {
    try {
      const controller = get('sessionController')
      const state = localState()
      if (!controller || typeof controller.prompt !== 'function' || !state.sessionId) return { ok: false }
      Promise.resolve(controller.prompt({ requestId: requireId(), sessionId: state.sessionId, mode: 'queue', content: [{ type: 'text', text: String(text || '') }] })).catch(() => {})
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  return { chat, bind, title: conf.title, role, assignTask, setTaskStatus, tasksBrief, readTasks, sessionTitleOf, localState, notice }
}

export const ROLE_CHAT_CONF = ROLES
