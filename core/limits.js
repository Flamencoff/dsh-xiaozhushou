/**
 * 熔断与停手三段（R-ENG-04；证据 OLD-44「我不给命令就是睡着了，不要无休止跑」）
 *
 * 三重上限：
 *   1) 步数：每个角色有自己的上限（config.limits.roleSteps）；
 *   2) 时间：单次任务的总时长上限；
 *   3) 连续受阻：连续 N 轮没有进展 → 视为"用户睡了"，停手等指令。
 *
 * 停手三段（不一次就死）：
 *   回头看（整理现状）→ 换招（改法再试一次）→ 彻底停（保留现场等指令）
 *
 * 铁律：**预算不因重试而放大**（旧版踩过的坑：重试把上限乘上去了）。
 * 纯函数，不碰宿主。
 */

export const DEFAULT_LIMITS = {
  roleSteps: { secretary: 8, ceo: 30, historian: 60 },
  roleMinutes: { secretary: 5, ceo: 10, historian: 5 },
  blockedRoundsBeforeStop: 3,
  subagent: { maxTurns: 10, maxDepth: 2, maxConcurrent: 3 },
}

/**
 * @param {{role:string, steps?:number, startedAt?:number|string, blockedRounds?:number, config?:object, now?:number}} input
 * @returns {{verdict:'go'|'look-back'|'change-tactic'|'stop', reason:string, detail:object}}
 */
export function evaluate(input = {}) {
  const limits = mergeLimits(input.config)
  const role = normalizeRole(input.role)
  const now = Number(input.now) || Date.now()
  const steps = Math.max(0, Number(input.steps) || 0)
  const blockedRounds = Math.max(0, Number(input.blockedRounds) || 0)

  const maxSteps = limits.roleSteps[role] || limits.roleSteps.secretary
  const maxMinutes = limits.roleMinutes[role] || limits.roleMinutes.secretary
  const started = toMs(input.startedAt)
  const elapsedMinutes = started ? (now - started) / 60000 : 0

  const detail = {
    role,
    steps,
    maxSteps,
    elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
    maxMinutes,
    blockedRounds,
    blockedRoundsBeforeStop: limits.blockedRoundsBeforeStop,
  }

  // 1) 连续受阻到阈值 → 彻底停（用户多半离开了）
  if (blockedRounds >= limits.blockedRoundsBeforeStop) {
    return { verdict: 'stop', reason: 'blocked_too_long', detail: { ...detail, message: '连着几轮没进展，我停手等你的指令，不继续烧钱' } }
  }

  // 2) 已经过半但没超 → 回头看
  const stepRatio = steps / maxSteps
  const timeRatio = started ? elapsedMinutes / maxMinutes : 0
  const ratio = Math.max(stepRatio, timeRatio)

  if (ratio >= 1) {
    return { verdict: 'stop', reason: 'limit_reached', detail: { ...detail, message: '到上限了，先停下把现状说清楚，等你定' } }
  }
  if (ratio >= 0.7) {
    return { verdict: 'change-tactic', reason: 'near_limit', detail: { ...detail, message: '快到头了，换一种做法试一次，不行就停' } }
  }
  if (blockedRounds > 0) {
    return { verdict: 'look-back', reason: 'blocked_once', detail: { ...detail, message: '这轮没进展，先回头看看卡在哪，别硬撞' } }
  }
  return { verdict: 'go', reason: 'ok', detail }
}

/** 子代理配额（深度/回合/并发）——由 createSpawner 或工具层调用前检查 */
export function checkSubagent(input = {}) {
  const limits = mergeLimits(input.config).subagent
  const depth = Math.max(0, Number(input.depth) || 0)
  const concurrent = Math.max(0, Number(input.concurrent) || 0)
  const turns = Math.max(0, Number(input.turns) || 0)
  if (depth > limits.maxDepth) return { ok: false, code: 'depth_limit', message: `子代理最多 ${limits.maxDepth} 层` }
  if (concurrent >= limits.maxConcurrent) return { ok: false, code: 'concurrency_limit', message: `同时最多 ${limits.maxConcurrent} 个子代理` }
  if (turns >= limits.maxTurns) return { ok: false, code: 'turn_limit', message: `单个子代理最多 ${limits.maxTurns} 回合` }
  return { ok: true }
}

/**
 * 重试不放大预算：返回下一轮该用的上限（永远不超过原上限）。
 * 旧版踩坑：重试时把 stepLimit 乘了 retryCount，越重试越能跑。
 */
export function budgetAfterRetry(baseLimit, retryCount) {
  const base = Math.max(1, Number(baseLimit) || 1)
  const retries = Math.max(0, Number(retryCount) || 0)
  if (!retries) return base
  // 不放大：重试只会让剩余预算更少，不会更多
  return Math.max(1, base - retries)
}

/* ── 小工具 ─────────────────────────────────────────────── */

function mergeLimits(config) {
  const incoming = (config && config.limits) || {}
  return {
    roleSteps: { ...DEFAULT_LIMITS.roleSteps, ...(incoming.roleSteps || {}) },
    roleMinutes: { ...DEFAULT_LIMITS.roleMinutes, ...(incoming.roleMinutes || {}) },
    blockedRoundsBeforeStop: Number(incoming.blockedRoundsBeforeStop) || DEFAULT_LIMITS.blockedRoundsBeforeStop,
    subagent: { ...DEFAULT_LIMITS.subagent, ...(incoming.subagent || {}) },
  }
}

function normalizeRole(role) {
  const text = String(role || '').toLowerCase()
  if (text.includes('ceo')) return 'ceo'
  if (text.includes('hist')) return 'historian'
  return 'secretary'
}

function toMs(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}
