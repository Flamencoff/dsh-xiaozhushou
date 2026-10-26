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

import { fourQuestions, singleLine } from './analysis.js'

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
  const { ledger, historian, handover, config, spawner, brain, notifier, finder, pusher, tasks: taskOps = null } = deps
  const log = typeof deps.log === 'function' ? deps.log : () => {}

  function roleEnabled(role) {
    return Boolean(config && config.enabled && config.enabled[role])
  }

  const secretary = {
    name: 'steward_secretary',
    description: '秘书：记/查待办、给一句话摘要。只负责日常事务，不做判断；需要判断时用 steward_ceo。',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add_todo', 'list_todos', 'summary', 'open_session', 'find_files', 'push_now', 'handoff_to_ceo'], description: '要做的事' },
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
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!roleEnabled('secretary')) return { ok: false, text: '秘书现在是关闭的（enabled.secretary=false）' }
      const action = args && args.action
      if (action === 'handoff_to_ceo') {
        if (!taskOps || typeof taskOps.assign !== 'function') return { ok: false, text: '这个环境没有任务板接口' }
        const made = taskOps.assign(String(args.title || '').trim(), String(args.facts || '').trim())
        if (!made || !made.ok) return { ok: false, text: (made && made.message) || '没挂到 CEO 名下' }
        return { ok: true, text: '已挂到 CEO 名下：' + made.task.id + ' ' + made.task.title + '（CEO 会自动接下）' }
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
    description: 'CEO：对一件事做四问 + 单线分析；或生成交接卡（短卡 + 底账）。只做判断，不记流水账。',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['analyze', 'handover', 'notify_secretary', 'tasks', 'accept_task', 'complete_task', 'archive_task', 'remember_task'], description: '要做的事' },
        topic: { type: 'string', description: '交接卡主题（handover 必填）' },
        task: { type: 'string', description: '一句话任务（handover 用）' },
        workspace: { type: 'string', description: '工作区（handover 用）' },
        write: { type: 'boolean', description: '是否真的写盘（默认 false，只返回文本）' },
        conclusion: { type: 'string', description: 'notify_secretary：一句话结论（≤60 字）' },
        todo: { type: 'array', items: { type: 'string' }, description: 'notify_secretary：留给秘书的待办（≤5 条）' },
        sessionId: { type: 'string', description: 'notify_secretary：涉及会话 id' },
        id: { type: 'string', description: 'accept/complete/archive/remember：任务号 K-xxx' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!roleEnabled('ceo')) return { ok: false, text: 'CEO 现在是关闭的（enabled.ceo=false）' }
      const action = args && args.action
      if (action === 'tasks') {
        if (!taskOps || typeof taskOps.list !== 'function') return { ok: false, text: '这个环境没有任务板接口' }
        const list = taskOps.list()
        const open = list.filter((task) => !['完成', '已归档', '已记忆'].includes(task.status))
        if (!open.length) return { ok: true, text: '任务板上没有待办任务。' }
        return { ok: true, text: open.map((task) => task.id + '｜' + task.title + '｜' + (task.assignee === 'ceo' ? 'CEO' : task.assignee) + '｜' + task.status).join('\n') }
      }
      if (['accept_task', 'complete_task', 'archive_task', 'remember_task'].includes(action)) {
        if (!taskOps) return { ok: false, text: '这个环境没有任务板接口' }
        const id = String((args && args.id) || '').trim().toUpperCase()
        if (!id) return { ok: false, text: '给个任务号 K-xxx' }
        let changed = null
        if (action === 'accept_task') changed = taskOps.setStatus(id, '进行中')
        if (action === 'complete_task') changed = taskOps.setStatus(id, '完成')
        if (action === 'archive_task') changed = taskOps.archive(id)
        if (action === 'remember_task') changed = taskOps.remember(id)
        if (!changed || !changed.ok) return { ok: false, text: (changed && changed.message) || '没处理成' }
        return { ok: true, text: '已处理 ' + id + (changed.text ? '：' + changed.text : '') + '（当前状态：' + (changed.task ? changed.task.status : '') + '）' }
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
      return { ok: false, text: 'CEO 支持的 action：analyze / handover / notify_secretary / tasks / accept_task / complete_task / archive_task / remember_task' }
    },
  }

  const historianTool = {
    name: 'steward_historian',
    description: '史官：按档位增量读会话并记录（只记录、不判断）。发布默认开启；读不了会如实报。',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read_increment'], description: '目前只有增量读取' },
        sessionId: { type: 'string', description: '只读指定会话；不填就按列表读' },
        dryRun: { type: 'boolean', description: '只算不写（默认 true）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!roleEnabled('historian')) return { ok: false, text: '史官现在是关闭的（enabled.historian=false）' }
      const action = args && args.action
      if (action !== 'read_increment') return { ok: false, text: '史官支持的 action：read_increment' }
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
