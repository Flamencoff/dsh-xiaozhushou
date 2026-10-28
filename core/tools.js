/**
 * 三个角色的工具（A1 的代码部分；官方 `ToolDefinition` 合同）
 *
 * 成本纪律（S8）：**合计只注册 3 个**工具，动作用 `action` 枚举收敛；
 * 默认注册但可一键关（config.tools.enabled=false）——工具会进每个会话的工具面，
 * 每个约 +7000 token/轮。
 *
 * 官方合同（本机核对 2026-10-26）：
 *   interface ToolDefinition extends ToolSchema {
 *     output: { schema, render(args, value): ContentBlock[] }
 *     execute(args, exec: ToolRunContext): Promise<unknown>
 *   }
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fourQuestions, singleLine } from './analysis.js'
import { EXECUTE_TITLE, buildExecutePrompt, buildExecuteTitle } from './ceo-execute.js'

export const TOOL_NAMES = ['steward_secretary', 'steward_ceo', 'steward_historian']

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, additionalProperties: true },
  render(_args, value) {
    const text = value && typeof value === 'object' && typeof value.text === 'string' ? value.text : JSON.stringify(value)
    return [{ type: 'text', text }]
  },
}

/**
 * @param {{ledger:any, inbox:any, historian:any, handover:any, config:any, snapshot?:any, log?:Function}} deps
 */
export function createToolset(deps) {
  const { ledger, historian, handover, config, spawner, brain, notifier, finder, pusher, tasks: taskOps = null, taskFlow = null, roleChats = {}, sessions: sessionOps = null } = deps
  const log = typeof deps.log === 'function' ? deps.log : () => {}

  const ROLE_LABELS = { secretary: '秘书', ceo: 'CEO', historian: '史官' }
  const messageTimes = []
  function messageRateAllowed() {
    const now = Date.now()
    while (messageTimes.length && now - messageTimes[0] > 3600000) messageTimes.shift()
    if (messageTimes.length >= 30) return false
    messageTimes.push(now)
    return true
  }
  const todayLocal = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) }
  async function messageRole(args, fromRole = '') {
    const target = String((args && args.target) || '').trim()
    const text = String((args && args.text) || '').trim().slice(0, 2000)
    if (!target || !ROLE_LABELS[target]) return { ok: false, text: '发给谁？target 只能是 secretary / ceo / historian' }
    if (target === fromRole) return { ok: false, text: '不用发给自己' }
    if (!text) return { ok: false, text: '要发什么？text 不能为空' }
    if (!messageRateAllowed()) return { ok: false, text: '一小时内最多发 30 条角色消息，先缓一缓' }
    const chat = roleChats && roleChats[target]
    if (!chat || typeof chat.notice !== 'function') return { ok: false, text: '没有这个角色的会话接口' }
    const sent = await chat.notice('【角色消息】' + text)
    if (!sent || !sent.ok) return { ok: false, text: ROLE_LABELS[target] + ' 的会话还没绑定，发不进去' }
    return { ok: true, text: '已发给' + ROLE_LABELS[target] + '：' + text.slice(0, 80) + '（不需要再回复）' }
  }

  function roleEnabled(role) {
    return Boolean(config && config.enabled && config.enabled[role])
  }

  const secretary = {
    name: 'steward_secretary',
    description: '秘书：记/查待办、摘要、把事转给 CEO（handoff_to_ceo）。不做判断；不要用团队工具。',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add_todo', 'list_todos', 'summary', 'open_session', 'find_files', 'push_now', 'handoff_to_ceo', 'message_role', 'scan_sessions', 'scan_add'], description: '要做的事' },
        title: { type: 'string', description: '待办标题（add_todo 必填，≤120 字）；或新会话标题（open_session）' },
        due: { type: 'string', description: '截止日期，YYYY-MM-DD 或 今天/明天' },
        confirmed: { type: 'boolean', description: 'open_session 必填：用户是否已口头同意开新会话' },
        firstPrompt: { type: 'string', description: 'open_session 的第一句话（新会话开场白）' },
        preset: { type: 'string', enum: ['steward-secretary', 'steward-ceo', 'steward-historian'], description: 'open_session：用哪个角色 preset（不给就用默认）' },
        query: { type: 'string', description: 'find_files：关键词（文件名或内容里找）' },
        root: { type: 'string', description: 'find_files：在哪个目录下找（必须在允许的目录里）' },
        mostUrgent: { type: 'boolean', description: '用户亲口说"最紧急"才置 true' },
        mostImportant: { type: 'boolean', description: '用户亲口说"最重要"才置 true' },
        facts: { type: 'string', description: 'handoff_to_ceo：带过去的事实底稿（用户原话/上下文）' },
        target: { type: 'string', enum: ['secretary', 'ceo', 'historian'], description: 'message_role：发给哪个角色' },
        text: { type: 'string', maxLength: 2000, description: 'message_role：要发过去的话（≤2000）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!roleEnabled('secretary')) return { ok: false, text: '秘书现在是关闭的（enabled.secretary=false）' }
      const action = args && args.action
      if (action === 'message_role') return await messageRole(args, 'secretary')
      if (action === 'handoff_to_ceo') {
        if (!taskOps || typeof taskOps.assign !== 'function') return { ok: false, text: '这个环境没有任务板接口' }
        const facts = String(args.facts || '').trim()
        const title = String(args.title || '').trim() || facts.split(/[。\n]/)[0].slice(0, 80).trim() || facts.slice(0, 80)
        const made = taskOps.assign(title, facts)
        if (!made || !made.ok) return { ok: false, text: (made && made.message) || '没挂到 CEO 名下' }
        const explicitNew = made.task && made.task.explicitNew === true
        const notified = roleChats && roleChats.ceo && typeof roleChats.ceo.notice === 'function'
          ? await roleChats.ceo.notice('秘书转交任务 ' + made.task.id + '：' + made.task.title + '\n背景：' + facts.slice(0, 800) + (explicitNew ? '\n这是用户明确要开的新任务：请开任务会话。' : '\n这不是明确要新建：先按标题/会话号搜旧会话；找到用 send_session 发进去；找不到先问用户是哪个会话、要不要新建，不要直接开会话。'))
          : { ok: false }
        return { ok: true, text: '已挂到 CEO 名下：' + made.task.id + ' ' + made.task.title + (notified.ok ? '（已通知 CEO 会话）' : '（CEO 会话没绑定，先挂在板上了）') }
      }
      if (action === 'add_todo') {
        const result = ledger.add({
          title: args.title,
          due: args.due,
          urgency: args.mostUrgent ? 3 : 1,
          importance: args.mostImportant ? 3 : 1,
          mostUrgent: Boolean(args.mostUrgent),
          mostImportant: Boolean(args.mostImportant),
          source: { kind: 'model', tool: 'steward_secretary' },
        })
        if (!result.ok) return { ok: false, text: result.message }
        const item = result.item
        const rank = item.mostUrgent || item.mostImportant ? '（带"最"，优先级最高）' : ''
        return { ok: true, text: `记下了 ${item.id}：${item.title}${rank}。还只是候选，确认之后才会提醒你。`, item }
      }
      if (action === 'list_todos') {
        const stats = ledger.stats()
        const lines = stats.confirmed.slice(0, 8).map((item) => `${item.id} ${item.title}${item.due ? '（' + item.due + '）' : ''}`)
        return {
          ok: true,
          text: lines.length
            ? `已确认 ${stats.confirmed.length} 条、待确认 ${stats.pendingCount} 条：\n` + lines.join('\n')
            : `还没有已确认的待办；待确认 ${stats.pendingCount} 条。`,
          stats,
        }
      }
      if (action === 'open_session') {
        if (!(deps.config && deps.config.session && deps.config.session.allowModelOpenSession)) {
          return { ok: false, text: '开会话请用看板上的「开新会话」按钮（模型工具路径默认关闭；要开路径请在配置里把 session.allowModelOpenSession 设为 true）' }
        }
        if (!spawner) return { ok: false, text: '这个环境不能自动开会话' }
        const result = await spawner.spawn({
          title: args.title,
          prompt: args.firstPrompt || '先读交接卡，再复述任务与边界，然后等我安排。',
          // 开会话以按钮为准；工具路径默认关闭
        confirmedByAuthor: args.confirmed === true && Boolean(deps.config && deps.config.session && deps.config.session.allowModelOpenSession),
          agentPreset: args.preset,
        })
        if (!result.ok) return { ok: false, text: result.message, code: result.code }
        return { ok: true, text: `开好了：${result.sessionId}。标题与第一句都备齐了。`, sessionId: result.sessionId }
      }
      if (action === 'push_now') {
        if (!pusher) return { ok: false, text: '这个环境不能推送' }
        let items = []
        try {
          const stats = ledger.stats()
          items = stats.confirmed
            .filter((item) => item.status === '已确认')
            .slice(0, 3)
            .map((item) => ({ id: item.id, title: item.title, due: item.due || '' }))
        } catch {
          items = []
        }
        if (!items.length) return { ok: false, text: '没有已确认的待办可推（先记一条并确认）' }
        const result = await pusher.push(items, new Date(), {})
        if (!result.ok) return { ok: false, text: result.message, code: result.code }
        return { ok: true, text: `推给沙盒会话了：${result.sessionId}（${items.length} 条）`, sessionId: result.sessionId, count: items.length }
      }
      if (action === 'find_files') {
        if (!finder) return { ok: false, text: '这个环境不能找文件' }
        const result = finder.find({ query: args.query, root: args.root, limit: 20 })
        if (!result.ok) return { ok: false, text: result.message }
        if (!result.hits.length) return { ok: true, text: result.message, hits: [] }
        const lines = result.hits.slice(0, 10).map((hit, i) => `${i + 1}. ${hit.relative}${hit.hit === 'content' ? '（命中内容：' + hit.snippet + '）' : ''}`)
        return {
          ok: true,
          text: `${result.message}：\n${lines.join('\n')}${result.timedOut ? '\n（时间到，可能没找全；缩小目录再试）' : ''}`,
          hits: result.hits,
        }
      }
      if (action === 'scan_sessions') {
        if (!sessionOps || typeof sessionOps.scan !== 'function') return { ok: false, text: '这个环境不能扫会话' }
        const scanned = await sessionOps.scan(8)
        if (!scanned.ok) return { ok: false, text: scanned.message || '扫不了' }
        if (!scanned.candidates.length) return { ok: true, text: '扫了最近 8 个会话，没找到像待办的句子' }
        return { ok: true, text: '扫到 ' + scanned.candidates.length + ' 条候选（只读，不自动确认）：\n' + scanned.candidates.map((item, i) => (i + 1) + '. ' + item.title + '（' + item.confidence + '，约 ' + (Math.max(1, Math.round(Number(item.estimate_slots) / 2)) + ' 小时') + '）').join('\n') }
      }
      if (action === 'scan_add') {
        if (!sessionOps || typeof sessionOps.scan !== 'function') return { ok: false, text: '这个环境不能扫会话' }
        const scanned = await sessionOps.scan(8)
        if (!scanned.ok) return { ok: false, text: scanned.message || '扫不了' }
        let added = 0
        for (const item of scanned.candidates) {
          const made = ledger.add({ title: item.title, urgency: item.urgency, importance: item.importance, source: { kind: 'session-scan', sessionId: item.sessionId, at: item.scannedAt }, detail: item.evidence, estimate_slots: item.estimate_slots })
          if (made && made.ok) added += 1
        }
        return { ok: true, text: added ? '扫到并记成候选 ' + added + ' 条（都是候选，确认后才提醒）' : '扫到 ' + scanned.candidates.length + ' 条，但一条也没记进去' }
      }
      if (action === 'summary') {
        const stats = ledger.stats()
        const text = `已确认 ${stats.confirmed.length} 条、待确认 ${stats.pendingCount} 条、今天完成 ${stats.doneToday || 0} 条。`
        return { ok: true, text: text.length > 100 ? text.slice(0, 97) + '…' : text }
      }
      return { ok: false, text: '秘书支持的 action：add_todo / list_todos / summary / open_session / find_files / push_now / handoff_to_ceo' }
    },
  }

  const ceo = {
    name: 'steward_ceo',
    description: 'CEO：判断、查/接/完成/归档任务、存为记忆、开任务会话（open_task）。只做判断与执行，不记流水账。',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['analyze', 'handover', 'notify_secretary', 'tasks', 'accept_task', 'complete_task', 'archive_task', 'remember_task', 'open_task', 'message_role', 'sessions', 'send_session', 'scan_sessions'], description: '要做的事' },
        topic: { type: 'string', description: '交接卡主题（handover 必填）' },
        task: { type: 'string', maxLength: 2000, description: '一句话任务（handover/open_task 用，≤2000）' },
        workspace: { type: 'string', description: '工作区（handover 用）' },
        write: { type: 'boolean', description: '是否真的写盘（默认 false，只返回文本）' },
        conclusion: { type: 'string', description: 'notify_secretary：一句话结论（≤60 字）' },
        todo: { type: 'array', items: { type: 'string' }, description: 'notify_secretary：留给秘书的待办（≤5 条）' },
        sessionId: { type: 'string', description: 'notify_secretary：涉及会话 id' },
        id: { type: 'string', description: 'accept/complete/archive/remember：任务号 K-xxx' },
        query: { type: 'string', maxLength: 200, description: 'sessions：按标题/会话号搜索' },
        sessionId: { type: 'string', description: 'send_session：目标会话 id' },
        result: { type: 'string', description: 'complete_task：结果摘要/产出路径' },
        target: { type: 'string', enum: ['secretary', 'ceo', 'historian'], description: 'message_role：发给哪个角色' },
        text: { type: 'string', maxLength: 2000, description: 'message_role：要发过去的话（≤2000）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!roleEnabled('ceo')) return { ok: false, text: 'CEO 现在是关闭的（enabled.ceo=false）' }
      const action = args && args.action
      if (action === 'message_role') return await messageRole(args, 'ceo')
      if (action === 'sessions') {
        if (!sessionOps || typeof sessionOps.list !== 'function') return { ok: false, text: '这个环境读不到会话列表' }
        const rows = await sessionOps.list(args.query)
        if (!rows.length) return { ok: true, text: '没找到匹配的会话' + (args.query ? '：' + String(args.query) : '') }
        return { ok: true, text: rows.map((row) => row.id + '｜' + (row.title || '（无标题）') + '｜' + (row.live ? 'live' : '') + (row.preset ? '｜' + row.preset : '')).join('\n') }
      }
      if (action === 'send_session') {
        if (!sessionOps || typeof sessionOps.prompt !== 'function') return { ok: false, text: '这个环境不能给会话发消息' }
        const id = String((args && args.sessionId) || '').trim()
        const text = String((args && args.text) || '').trim()
        if (!id) return { ok: false, text: '给个会话 id（先用 sessions 找）' }
        if (!text) return { ok: false, text: '要发什么指令？' }
        const sent = await sessionOps.prompt(id, '【CEO 指令】' + text)
        if (!sent || !sent.ok) return { ok: false, text: (sent && sent.message) || '没发进去' }
        return { ok: true, text: '已把指令发进会话 ' + id + '（一次性，不新建会话）' }
      }
      if (action === 'open_task') {
        if (!spawner || typeof spawner.spawn !== 'function') return { ok: false, text: '这个环境不能开新会话（spawner 不可用）' }
        const task = String((args && (args.task || args.topic)) || '').trim().slice(0, 2000)
        if (!task) return { ok: false, text: '要开什么任务会话？给一句任务说明' }
        if (!taskOps || typeof taskOps.assign !== 'function') return { ok: false, text: '这个环境没有任务板接口' }
        const made = taskOps.assign(task, '（CEO 开任务会话时自动登记）', true)
        if (!made || !made.ok) return { ok: false, text: (made && made.message) || '任务登记失败' }
        const card = taskFlow && typeof taskFlow.writeHandoff === 'function' ? taskFlow.writeHandoff({ task: made.task }) : { ok: false }
        const sessionTitle = buildExecuteTitle(task)
        const spawned = await spawner.spawn({
          title: sessionTitle,
          prompt: buildExecutePrompt(task, { handoffCard: card.ok ? card.path : '' }),
          confirmedByAuthor: true,
        })
        if (!spawned || !spawned.ok) {
          if (typeof taskOps.patch === 'function') taskOps.patch(made.task.id, { status: '待办', spawnError: String((spawned && spawned.message) || 'no_session') })
          return { ok: false, text: '任务已登记 ' + made.task.id + '，但开会话失败：' + String((spawned && spawned.message) || '没建起来') + '（已退回待办）' }
        }
        if (typeof taskOps.patch === 'function') taskOps.patch(made.task.id, { sessionId: spawned.sessionId, handoffCard: card.ok ? card.path : '' })
        const card2 = taskFlow && typeof taskFlow.writeHandoff === 'function' ? taskFlow.writeHandoff({ task: { ...made.task, sessionId: spawned.sessionId }, sessionId: spawned.sessionId }) : card
        return { ok: true, text: '已开好任务会话「' + sessionTitle + '」（' + spawned.sessionId + '）：任务 ' + made.task.id + ' 已登记，交接卡：' + (card2.ok ? card2.path : '（没写成）') }
      }
      if (action === 'tasks') {
        if (!taskOps || typeof taskOps.list !== 'function') return { ok: false, text: '这个环境没有任务板接口' }
        const list = taskOps.list()
        const open = list.filter((task) => !['完成', '已归档', '已记忆'].includes(task.status))
        if (!open.length) return { ok: true, text: '任务板上没有待办任务。' }
        return { ok: true, text: open.map((task) => task.id + '｜' + task.title + '｜优先级：' + ((task.priority && task.priority.label) || '常规') + '｜' + (task.assignee === 'ceo' ? 'CEO' : task.assignee) + '｜' + task.status).join('\n') }
      }
      if (['accept_task', 'complete_task', 'archive_task', 'remember_task'].includes(action)) {
        if (!taskOps) return { ok: false, text: '这个环境没有任务板接口' }
        const id = String((args && args.id) || '').trim().toUpperCase()
        if (!id) return { ok: false, text: '给个任务号 K-xxx' }
        const before = typeof taskOps.list === 'function' ? taskOps.list().find((item) => item.id === id) : null
        let changed = null
        if (action === 'accept_task') changed = taskOps.setStatus(id, '进行中')
        if (action === 'complete_task') changed = taskOps.setStatus(id, '完成')
        if (action === 'archive_task') changed = taskOps.archive(id)
        if (action === 'remember_task') changed = taskOps.remember(id)
        if (!changed || !changed.ok) return { ok: false, text: (changed && changed.message) || '没处理成' }
        let sessionNote = ''
        if (action === 'accept_task' && before && !before.sessionId && before.explicitNew !== true) {
          sessionNote = '；没有自动开新会话：先搜旧会话，找不到先问用户是哪个会话、要不要新建'
        }
        if (action === 'accept_task' && before && !before.sessionId && before.explicitNew === true && spawner && typeof spawner.spawn === 'function') {
          const card = taskFlow && typeof taskFlow.writeHandoff === 'function' ? taskFlow.writeHandoff({ task: before }) : { ok: false }
          const spawned = await spawner.spawn({
            title: buildExecuteTitle(before.title),
            prompt: buildExecutePrompt(before.title, { handoffCard: card.ok ? card.path : '' }),
            confirmedByAuthor: true,
          })
          if (spawned && spawned.ok && typeof taskOps.patch === 'function') taskOps.patch(id, { sessionId: spawned.sessionId, handoffCard: card.ok ? card.path : '' })
          if (spawned && spawned.ok && taskFlow && typeof taskFlow.writeHandoff === 'function') taskFlow.writeHandoff({ task: { ...before, sessionId: spawned.sessionId }, sessionId: spawned.sessionId })
          sessionNote = spawned && spawned.ok ? '；已开执行会话 ' + spawned.sessionId : '；执行会话没开成：' + String((spawned && spawned.message) || '')
        }
        if (action === 'complete_task' && args && args.result && taskFlow && typeof taskFlow.writeResult === 'function') {
          const written = taskFlow.writeResult({ task: before || changed.task, result: args.result })
          if (written && written.ok && typeof taskOps.patch === 'function') taskOps.patch(id, { resultPath: written.path, resultSummary: String(args.result).slice(0, 4000) })
          sessionNote += written && written.ok ? '；结果已写 ' + written.path : '；结果没写成'
        }
        return { ok: true, text: '已处理 ' + id + (changed.text ? '：' + changed.text : '') + '（当前状态：' + (changed.task ? changed.task.status : '') + '）' + sessionNote }
      }
      if (action === 'analyze') {
        const liveSnapshot = typeof deps.snapshot === 'function' ? deps.snapshot() : deps.snapshot
        return runCeoAnalysis({ ledger, snapshot: liveSnapshot, brain })
      }
      if (action === 'notify_secretary') {
        if (!notifier) return { ok: false, text: '这个环境不能写备案' }
        const result = notifier.write({
          topic: args.topic,
          conclusion: args.conclusion,
          todo: args.todo,
          sessionId: args.sessionId,
          role: 'ceo',
        })
        if (!result.ok) return { ok: false, text: result.message }
        return { ok: true, text: '已给秘书留备案：' + result.record.topic + ' → ' + result.record.conclusion, record: result.record }
      }
      if (action === 'handover') {
        const result = handover.create({
          topic: args.topic,
          task: args.task,
          workspace: args.workspace,
          write: Boolean(args.write),
        })
        if (!result.ok) return { ok: false, text: result.message || '交接卡没生成' }
        const where = result.written ? `\n已写盘：${result.written.cardPath}\n底账：${result.written.ledgerPath}` : '\n（没写盘；要落盘就把 write 设成 true）'
        return { ok: true, text: '交接卡（短卡）：\n' + result.card + where, card: result.card, written: result.written }
      }
      return { ok: false, text: 'CEO 支持的 action：analyze / handover / notify_secretary / tasks / accept_task / complete_task / archive_task / remember_task / open_task / sessions / send_session / message_role' }
    },
  }

  const historianTool = {
    name: 'steward_historian',
    description: '史官：增量读会话并记录，或列出已落盘言行录（list_records）。只记录、不判断。',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read_increment', 'list_records', 'list_feeds', 'message_role'], description: '增量读取 / 列出言行录 / 列出投喂卡 / 发消息' },
        sessionId: { type: 'string', description: '只读指定会话；不填就按列表读' },
        dryRun: { type: 'boolean', description: '只算不写（默认 true）' },
        date: { type: 'string', description: 'list_records：日期 YYYY-MM-DD（默认今天）' },
        limit: { type: 'number', description: 'list_records/list_feeds：最多列几条（默认 50，最多 200）' },
        target: { type: 'string', enum: ['secretary', 'ceo', 'historian'], description: 'message_role：发给哪个角色' },
        text: { type: 'string', maxLength: 2000, description: 'message_role：要发过去的话（≤2000）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!roleEnabled('historian')) return { ok: false, text: '史官现在是关闭的（enabled.historian=false）' }
      const action = args && args.action
      if (action === 'message_role') return await messageRole(args, 'historian')
      if (action === 'list_feeds') {
        if (!historian || !historian.historianRoot) return { ok: false, text: '这个环境读不到史官目录' }
        const limit = Math.max(1, Math.min(200, Number((args && args.limit) || 20)))
        const date = String((args && args.date) || '').trim()
        let files = []
        try {
          files = (await import('node:fs')).readdirSync(join(historian.historianRoot, '投喂'))
            .filter((name) => name.endsWith('.md') && (!date || name.startsWith(date)))
            .sort()
            .slice(-limit)
        } catch {
          return { ok: true, text: '还没有投喂卡（任务完成并「存为记忆」后才会生成）' }
        }
        if (!files.length) return { ok: true, text: '没有符合条件的投喂卡' }
        const chunks = []
        for (const name of files) {
          try {
            const text = readFileSync(join(historian.historianRoot, '投喂', name), 'utf8').trim()
            chunks.push('### ' + name + '\n' + text)
          } catch {}
        }
        return { ok: true, text: '投喂卡 ' + files.length + ' 张：\n\n' + chunks.join('\n\n').slice(0, 12000) }
      }
      if (action === 'list_records') {
        if (!historian || !historian.historianRoot) return { ok: false, text: '这个环境读不到言行录目录' }
        const date = String((args && args.date) || '').trim() || todayLocal()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, text: '日期格式要 YYYY-MM-DD' }
        const limit = Math.max(1, Math.min(200, Number((args && args.limit) || 50)))
        const file = join(historian.historianRoot, '言行录', date.slice(0, 7), date + '.md')
        if (!existsSync(file)) return { ok: true, text: '没有 ' + date + ' 的言行录（点「真跑一次」才会写）' }
        const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.startsWith('- '))
        if (!lines.length) return { ok: true, text: date + ' 的言行录还没有记录' }
        return { ok: true, text: ('言行录 ' + date + ' 共 ' + lines.length + ' 条，最后 ' + Math.min(limit, lines.length) + ' 条：\n' + lines.slice(-limit).join('\n')).slice(0, 12000) }
      }
      if (action !== 'read_increment') return { ok: false, text: '史官支持的 action：read_increment / list_records / list_feeds' }
      const result = await historian.record({
        sessionId: args.sessionId,
        dryRun: args.dryRun === undefined ? true : Boolean(args.dryRun),
      })
      if (!result.ok) return { ok: false, text: result.message || '没读成' }
      const detail = result.sessions
        .map((item) => `${item.sessionId}：${item.ok ? item.records + ' 条' : '失败 ' + (item.code || '')}`)
        .join('；')
      return { ok: true, text: `${result.message}${result.dryRun ? '（只算没写）' : ''}\n${detail}`, result }
    },
  }

  const tools = [secretary, ceo, historianTool]
  log('toolset ready: ' + tools.map((tool) => tool.name).join(', '))
  return tools
}
/* ── 模型输出的解析与降级 ─────────────────────────────── */

function safeStats(ledger) {
  try {
    return ledger.stats()
  } catch {
    return { confirmed: [], pendingCount: 0, doneCount: 0 }
  }
}

/** 从模型回包里抠出 JSON；抠不出来返回 null（调用方退回规则版） */
export async function runCeoAnalysis({ ledger, snapshot, brain, question }) {
  const now = new Date()
  let runtimeModelNote = ''
  const ruleFour = fourQuestions({ ledger, snapshot, now })
  const ruleLine = singleLine({ ledger, snapshot, now })
  const sourceNote = (text) => (runtimeModelNote ? text + '\n\n（' + runtimeModelNote + '）' : text)

  if (!brain || !brain.available()) {
    runtimeModelNote = '模型没开或没选默认模型，先按规则版给你结论'
  }
  if (brain && brain.available()) {
    const stats = safeStats(ledger)
    const pendingBrief = (stats.pending || []).slice(0, 8).map((item) => item.id + '｜' + item.title).join('\n')
    const brief = stats.confirmed.slice(0, 10).map((item) => item.id + '｜' + item.title + '｜截止:' + (item.due || '未定') + '｜急:' + item.urgency + '/3｜重:' + item.importance + '/3').join('\n')
    const awaited = await brain.ask({
      system: '你是项目 CEO，只做判断。输出严格 JSON，不要任何解释文字。',
      prompt: buildCeoPrompt(stats, pendingBrief, brief),
      maxTokens: 4000,
    })
    if (!awaited.ok) {
      runtimeModelNote = (awaited.code === 'timeout' ? '等太久了' : awaited.code === 'empty_reply' ? '模型这次没写出正文' : '模型没答成') + '，先按规则版给你结论'
    } else {
      const parsed = parseAnalysis(awaited.text)
      if (!parsed) runtimeModelNote = '模型回了内容但不是约定的 JSON，先按规则版给你结论'
      if (parsed) {
        return {
          ok: true,
          source: 'model',
          text: formatAnalysis(parsed, 'model'),
          four: { ...parsed.four, source: 'model', at: now.toISOString() },
          line: { ...parsed.line, source: 'model', at: now.toISOString() },
        }
      }
    }
  }

  const text = [
    '四问（规则版）：',
    '· 做了什么：' + ruleFour.done,
    '· 没做完：' + ruleFour.todo,
    '· 下一步：' + ruleFour.next,
    '· 哪个更急：' + ruleFour.urgent,
    '',
    '单线分析（规则版）：',
    '· 结论：' + ruleLine.conclusion,
    '· 依据：' + ruleLine.evidence.join('；'),
    '· 风险：' + ruleLine.risk,
    '· 推荐：' + ruleLine.recommend,
    '· 要不要拍板：' + ruleLine.decision,
  ].join('\n')
  return { ok: true, source: 'rule', text: sourceNote(text), four: ruleFour, line: ruleLine }
}

function buildCeoPrompt(stats, pendingBrief, brief) {
  return [
    '根据下面的待办台账，输出 JSON：',
    '{"four":{"done":"","todo":"","next":"","urgent":""},"line":{"conclusion":"","evidence":["…（强|中|弱·来源）"],"risk":"","options":["",""],"recommend":"","decision":""}}',
    '要求：四问每句 ≤40 字；单线 ≤12 行；依据必须带强弱与来源（来源写"台账"或"采集"）；不确定写"待核对"；不要编造台账里没有的事。',
    '',
    '待确认 ' + stats.pendingCount + ' 条、已完成 ' + stats.doneCount + ' 条。',
    '待确认待办（只给标题）：',
    pendingBrief || '（无）',
    '已确认待办：',
    brief || '（空）',
  ].join('\n')
}

export function parseAnalysis(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const data = JSON.parse(text.slice(start, end + 1))
    if (!data || !data.four || !data.line) return null
    return {
      four: {
        done: clipText(data.four.done, 40),
        todo: clipText(data.four.todo, 40),
        next: clipText(data.four.next, 40),
        urgent: clipText(data.four.urgent, 40),
      },
      line: {
        conclusion: clipText(data.line.conclusion, 60),
        evidence: Array.isArray(data.line.evidence) ? data.line.evidence.slice(0, 4).map((x) => clipText(x, 80)) : [],
        risk: clipText(data.line.risk, 60),
        options: Array.isArray(data.line.options) ? data.line.options.slice(0, 3).map((x) => clipText(x, 60)) : [],
        recommend: clipText(data.line.recommend, 60),
        decision: clipText(data.line.decision, 40),
      },
    }
  } catch {
    return null
  }
}

export function formatAnalysis(parsed, source) {
  const tag = source === 'model' ? '模型版' : '规则版'
  return [
    `四问（${tag}）：`,
    `· 做了什么：${parsed.four.done}`,
    `· 没做完：${parsed.four.todo}`,
    `· 下一步：${parsed.four.next}`,
    `· 哪个更急：${parsed.four.urgent}`,
    '',
    `单线分析（${tag}）：`,
    `· 结论：${parsed.line.conclusion}`,
    `· 依据：${(parsed.line.evidence || []).join('；')}`,
    `· 风险：${parsed.line.risk}`,
    `· 推荐：${parsed.line.recommend}`,
    `· 要不要拍板：${parsed.line.decision}`,
  ].join('\n')
}

function clipText(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max) + '…'
}
