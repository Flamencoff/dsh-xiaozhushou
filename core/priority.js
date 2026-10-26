/**
 * 优先级层（用户 2026-10-26 要求：四象限之上再加一层）
 *
 * 用户原话：
 *   "紧急重要那四个象限，上面要加一层优先级；用户专门提到的'最'紧急、'最'重要，
 *    一旦说了最，优先级要再提一级；提醒效果考虑红色闪烁，或者 2 个红灯、3 个红灯。"
 *
 * 规则（可算、可解释）：
 *   1) 先按紧急×重要落象限，得基础级：
 *        紧急且重要 = 4（马上做）
 *        重要不紧急 = 3（计划做）
 *        紧急不重要 = 2（快处理）
 *        都不沾     = 1（往后放）
 *   2) 用户说"最紧急"→ +1，"最重要"→ +1（两个说全了就 +2），封顶 5。
 *   3) 级别决定提醒长相：
 *        5 最急   → 3 个红灯 + 闪烁
 *        4 急     → 2 个红灯
 *        3 重要   → 1 个黄灯
 *        2 急办   → 1 个橙灯
 *        1 常规   → 1 个蓝灯
 *
 * 全是纯函数，不碰宿主、不调模型。
 */

// 用户 2026-10-26 定稿：**只用一个灯**
//   紧急且重要 → 红；单紧急 → 红；单重要 → 黄；"最" → 闪。
// 无紧急也无重要 → 蓝（不打扰）。
export const PRIORITY_LEVELS = {
  5: { level: 5, label: '最急', quadrant: '紧急且重要', dots: 1, color: 'red', blink: true, hint: '"最"级：闪给你看' },
  4: { level: 4, label: '急', quadrant: '紧急且重要', dots: 1, color: 'red', blink: false, hint: '又急又重要，排今天就做' },
  3: { level: 3, label: '重要', quadrant: '重要不紧急', dots: 1, color: 'warn', blink: false, hint: '重要但不急，排计划（黄灯）' },
  2: { level: 2, label: '急办', quadrant: '紧急不重要', dots: 1, color: 'red', blink: false, hint: '急但不重要，快处理掉（红灯）' },
  1: { level: 1, label: '常规', quadrant: '不紧急不重要', dots: 1, color: 'blue', blink: false, hint: '往后放，想起来再说' },
}

/** 判定一个待办的优先级 */
export function computePriority(item) {
  const urgency = clampLevel(item && item.urgency)
  const importance = clampLevel(item && item.importance)
  const mostUrgent = Boolean(item && item.mostUrgent)
  const mostImportant = Boolean(item && item.mostImportant)

  const urgent = urgency >= 2
  const important = importance >= 2
  const base = urgent && important ? 4 : important ? 3 : urgent ? 2 : 1
  const boost = (mostUrgent ? 1 : 0) + (mostImportant ? 1 : 0)
  const level = Math.min(5, base + boost)
  const meta = PRIORITY_LEVELS[level]

  return {
    level,
    label: meta.label,
    quadrant: meta.quadrant,
    dots: meta.dots,
    color: meta.color,
    blink: meta.blink,
    hint: meta.hint,
    base,
    boost,
    mostUrgent,
    mostImportant,
  }
}

/** 按优先级从高到低排（同级按截止时间早的在前） */
export function rankByPriority(items) {
  return (items || [])
    .map((item) => ({ item, priority: computePriority(item) }))
    .sort((a, b) => {
      if (b.priority.level !== a.priority.level) return b.priority.level - a.priority.level
      const da = a.item && a.item.due ? String(a.item.due) : '9999-99-99'
      const db = b.item && b.item.due ? String(b.item.due) : '9999-99-99'
      return da < db ? -1 : da > db ? 1 : 0
    })
    .map((entry) => ({ ...entry.item, priority: entry.priority }))
}

/** 分组：给看板"优先级"层用（高到低，空级不占位） */
export function groupByPriority(items) {
  const ranked = rankByPriority(items)
  const groups = []
  for (const level of [5, 4, 3, 2, 1]) {
    const meta = PRIORITY_LEVELS[level]
    const members = ranked.filter((item) => item.priority.level === level)
    if (members.length) groups.push({ level, label: meta.label, quadrant: meta.quadrant, dots: meta.dots, color: meta.color, blink: meta.blink, items: members })
  }
  return groups
}

/**
 * 一批待办合起来该用什么提醒长相（取最高的那条）
 * @returns {{level:number, dots:number, color:string, blink:boolean, count:number, label:string}}
 */
export function overallSignal(items) {
  const ranked = rankByPriority(items)
  if (!ranked.length) return { level: 0, dots: 0, color: 'green', blink: false, count: 0, label: '没什么要提醒的' }
  const top = ranked[0].priority
  const atTop = ranked.filter((item) => item.priority.level === top.level)
  return { level: top.level, dots: top.dots, color: top.color, blink: top.blink, count: atTop.length, label: top.label }
}

function clampLevel(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(3, Math.max(1, Math.round(n)))
}
