/**
 * CEO 的判断层（M4 第一步：规则版）
 *
 * 按 R-ROL-05 / R-ROL-06：
 *   · 四问＝四句、每句 ≤40 字；
 *   · 单线分析 ≤12 行：结论 / 依据（带来源与强中弱）/ 风险 / 选项 / 推荐 / 要不要拍板；
 *   · 模型不可用 → **规则版**，并明确标注 `source:'rule'`（不假装是模型结论）。
 *
 * 本模块是纯函数：只用台账 + 采集快照 + 时间，不读会话内容、不调模型。
 * M4 后半接上模型后，模型版覆盖同结构，规则版作为降级。
 */

import { rankByPriority } from './priority.js'

const MAX_LINE = 40

export function fourQuestions(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date()
  const today = localDate(now)
  const stats = safeStats(input)
  const sessions = (input.snapshot && input.snapshot.sessions) || []
  const live = sessions.filter((s) => s && s.live).length

  const dueToday = stats.confirmed.filter((item) => item.due && String(item.due) <= today)
  const overdue = dueToday.filter((item) => item.due && String(item.due) < today)
  // 四问跟着优先级栏目走："下一步/最急"直接取优先级排序的第一条
  const ranked = rankByPriority(stats.confirmed)
  const top = ranked[0] || null
  const urgent = stats.confirmed.filter((item) => Number(item.urgency) >= 3 && Number(item.importance) >= 3)

  const done = (stats.doneToday || 0) > 0 ? `今天已完成 ${stats.doneToday} 条` : '今天还没划掉任何待办'
  const todo = stats.pendingCount > 0 ? `还有 ${stats.pendingCount} 条待确认` : '没有待确认的候选'
  const next = top
    ? `先做 ${top.title}（优先级 ${top.priority ? top.priority.level : '—'} 级）`
    : '暂无已确认事项，等你派活'
  const urgencyText = overdue.length
    ? `有 ${overdue.length} 条已过期，最急`
    : dueToday.length
      ? `${dueToday.length} 条今天到期，最急`
      : urgent.length
        ? '没有到期项，紧急且重要的最优先'
        : '眼下没有紧急的'

  return {
    done: clip(done),
    todo: clip(todo),
    next: clip(next),
    urgent: clip(urgencyText),
    source: 'rule',
    at: new Date(now.getTime()).toISOString(),
    meta: { dueToday: dueToday.length, overdue: overdue.length, live, confirmed: stats.confirmed.length, pending: stats.pendingCount },
  }
}

export function singleLine(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date()
  const today = localDate(now)
  const stats = safeStats(input)
  const dueToday = stats.confirmed.filter((item) => item.due && String(item.due) <= today)
  const overdue = dueToday.filter((item) => item.due && String(item.due) < today)
  const urgent = stats.confirmed.filter((item) => Number(item.urgency) >= 3 && Number(item.importance) >= 3)
  const live = ((input.snapshot && input.snapshot.sessions) || []).filter((s) => s && s.live).length

  const conclusion = overdue.length
    ? `先清掉 ${overdue.length} 条过期项，再谈别的`
    : dueToday.length
      ? `今天把 ${dueToday.length} 条到期项做完就够`
      : stats.confirmed.length
        ? '按截止时间顺序推进，不用抢'
        : '没有已确认事项，等你定方向'

  const evidence = []
  evidence.push({ text: `台账：已确认 ${stats.confirmed.length} 条、待确认 ${stats.pendingCount} 条`, strength: 'strong', ref: '待办.json' })
  if (dueToday.length) evidence.push({ text: `其中 ${dueToday.length} 条今天或更早到期`, strength: 'strong', ref: '待办.json' })
  if (live) evidence.push({ text: `另有 ${live} 个会话在跑，别把它们当空闲`, strength: 'medium', ref: '采集.json' })
  if (!stats.confirmed.length) evidence.push({ text: '没有任何已确认的待办，结论只能靠规则兜底', strength: 'weak', ref: '台账为空' })

  const risk = overdue.length
    ? '过期项继续堆，后面会挤成一团'
    : dueToday.length
      ? '今天不做完会变成明天的过期项'
      : '暂无明显风险'

  const options = [
    `先把今天的到期项做完（${dueToday.length || 0} 条）`,
    urgent.length ? `先做紧急且重要的（${urgent.length} 条）` : '按原计划顺序推进',
  ]
  if (stats.pendingCount) options.push(`先花两分钟把 ${stats.pendingCount} 条候选确认掉`)

  const recommend = dueToday.length || urgent.length ? options[0] : '先确认候选，再决定做哪件'
  const decision = stats.pendingCount || urgent.length > 1 ? '要 —— 顺序你来定' : '不用 —— 照这个走就行'

  return {
    conclusion: clip(conclusion, 60),
    evidence: evidence.map((item) => `${item.text}（${strengthLabel(item.strength)}·${item.ref}）`),
    risk: clip(risk, 60),
    options: options.map((item) => clip(item, 60)),
    recommend: clip(recommend, 60),
    decision: clip(decision, 40),
    source: 'rule',
    at: now.toISOString(),
  }
}

/**
 * 交接卡：短卡（≤1 页）+ 底账骨架（对应 K10 的两层结构、C-46 的底账字段）
 * @param {{topic:string, workspace?:string, initiator?:string, task?:string, progress?:string[], files?:string[], next?:string[], rules?:string[], forbidden?:string[], changed?:string, confirmedQa?:string[], unfinished?:string[]}} input
 */
export function handoverCard(input = {}) {
  // FIX-10：所有入卡字段都截断，防止 2 万字 topic 撑出 181KB 响应
  const clip = (value, max) => {
    const text = String(value || '').replace(/s+$/g, '')
    return text.length > max ? text.slice(0, max) + '…' : text
  }
  const topic = clip(String(input.topic || '未命名任务').trim(), 80)
  const date = localDate(input.now instanceof Date ? input.now : new Date())
  const initiator = input.initiator || 'user'
  const workspace = clip(input.workspace || '（未指定）', 120)

  const card = [
    `# 交接卡 · ${topic} · ${date}`,
    '',
    `> initiator: ${initiator}　workspace: ${workspace}`,
    '',
    '## 一句话任务',
    input.task || '（待补：一句话说清这次要干什么）',
    '',
    '## 当前进展',
    ...bullet(input.progress, 5, '（待补：3–5 条）'),
    '',
    '## 任务有没有变',
    input.changed || '没变',
    '',
    '## 已确认的问答',
    ...bullet(input.confirmedQa, 5, '（无）'),
    '',
    '## 未完成 / 待复核',
    ...bullet(input.unfinished, 5, '（无）'),
    '',
    '## 关键文件 / 会话',
    ...bullet(input.files, 8, '（待补：路径或会话 id）'),
    '',
    '## 规则索引（只给索引，不写全文）',
    ...bullet(input.rules, 6, '- 项目总规则 → 13_项目总规则.md'),
    '',
    '## 下一步建议',
    ...bullet(input.next, 3, '（待补：1–3 条）'),
    '',
    '## 禁止事项（只列与本任务相关的）',
    ...bullet(input.forbidden, 5, '- 不修改旧归档；GitHub 写操作需逐次许可'),
    '',
    '---',
    '粉色大象自检：以上规则是否都服务本次任务主线？不服务的移到"遥远待办"。',
    '',
  ].join('\n')

  const ledger = [
    `# 底账 · ${topic} · ${date}`,
    '',
    '> 卡只做索引（≤1 页），深度内容放这里；新会话按需读。',
    '',
    '## 位置映射表',
    '| 东西 | 在哪 |',
    '|---|---|',
    '| 任务卡 | （待补） |',
    '| 产出 | （待补） |',
    '| 底账 | 本文件 |',
    '',
    '## 已知坑',
    '- （待补：踩过的坑、为什么）',
    '',
    '## 逐支线启动词',
    '- 支线：<名字> → 启动词：`<一句话>`',
    '',
    '## 变更记录',
    `- ${date} 建立底账`,
    '',
  ].join('\n')

  return { ok: true, card, ledger, topic, date, initiator, workspace }
}

/* ── 小工具 ─────────────────────────────────────────────── */

function bullet(list, max, fallbackLine) {
  if (!Array.isArray(list) || !list.length) return [fallbackLine]
  return list.slice(0, max).map((item) => `- ${String(item).trim()}`)
}

function safeStats(input) {
  try {
    const stats = input.ledger && typeof input.ledger.stats === 'function' ? input.ledger.stats() : null
    return stats || { confirmed: [], pendingCount: 0, doneCount: 0, droppedCount: 0, skipped: 0 }
  } catch {
    return { confirmed: [], pendingCount: 0, doneCount: 0, droppedCount: 0, skipped: 0 }
  }
}

function strengthLabel(strength) {
  return strength === 'strong' ? '强' : strength === 'medium' ? '中' : '弱'
}

function clip(text, max = MAX_LINE) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max) + '…'
}

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
