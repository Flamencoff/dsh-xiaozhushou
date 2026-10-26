/**
 * 提醒与三定点（18_详细设计 §9；需求 R-ALM-01…R-ALM-06）
 *
 * 铁律：
 *   1) 提醒的唯一来源是"已确认的待办"——未确认的只当清单，绝不打扰（R-ALM-01）；
 *   2) 三定点（默认 08:05/12:05/18:05）只做**零成本重算 + 摘要**，不唤模型；
 *   3) 08:05 带"开机满 N 分钟"闸门，顺延不超过 N 次，超了并入下一档；
 *   4) 同一事项在去重窗口内只提醒一次（R-ALM-05）；
 *   5) 静默时段只算不弹（R-ALM-06）。
 *
 * 全部纯本地计算：不调模型、不发通知到会话。
 */

import { isClock, minutesOf } from './config.js'

const FILE = '提醒状态.json'

export function createAlarm({ store, config, ledger, startedAt }) {
  const state = store.read(FILE, { version: 1, lastFired: {}, lastNotified: {}, deferrals: {}, merged: {} })
  const alarmConfig = (config && config.alarm) || {}

  function persist() {
    return store.write(FILE, state)
  }

  /** 已确认且已到期（含今天）的待办 */
  function dueReminders(now) {
    const today = dateOf(now)
    const stats = safeStats(ledger)
    // 双保险：即使上游把候选混进来，这里也只认「已确认」（R-ALM-01 是硬规则）
    return stats.confirmed
      .filter((item) => item.status === '已确认')
      .filter((item) => item.due && String(item.due) <= today)
      .map((item) => ({
        key: `${item.id}|${item.due}`,
        id: item.id,
        title: item.title,
        due: item.due,
        urgency: item.urgency,
        importance: item.importance,
      }))
  }

  /**
   * 每次心跳调用。返回本次发生了什么，便于 /health 和测试观察。
   * @param {Date} now
   */
  function tick(now = new Date()) {
    const result = { at: now.toISOString(), fired: [], merged: [], deferred: [], suppressed: [], reminders: [], missed: [] }
    const times = Array.isArray(alarmConfig.fixedTimes) && alarmConfig.fixedTimes.length ? alarmConfig.fixedTimes : []
    if (!times.length) return result

    const today = dateOf(now)
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const grace = Number(alarmConfig.graceMinutes) || 30
    const firstSlotMin = Math.min(...times.map((t) => minutesOf(t)))

    // 1) 到点的定点：算出来、再决定弹不弹
    for (const slot of times) {
      const slotMin = minutesOf(slot)
      const key = `${today}|${slot}`
      if (state.lastFired[key]) continue
      if (nowMin < slotMin) continue
      if (nowMin > slotMin + grace) {
        // 已经过了宽限：这次就算了，记一笔，不要在下午再补早上的提醒
        state.lastFired[key] = now.toISOString()
        result.missed.push(slot)
        continue
      }

      // 2) 08:05 开机闸门：刚开机不算数，一直顺延到闸门时间过去为止。
      // 2026-10-26 修 B-08：原来按"每次 tick 记一次顺延"，10 分钟闸门却只允许 3 次（3 分钟），
      // 结果 3 分钟就把 08:05 并到 12:05，早上直接没提醒。现在只按时间判断。
      const bootMs = startedAt ? now.getTime() - new Date(startedAt).getTime() : Number.MAX_SAFE_INTEGER
      const bootGateMs = (Number(alarmConfig.bootGateMinutes) || 0) * 60_000
      const isFirstSlot = slotMin === firstSlotMin
      if (isFirstSlot && bootGateMs > 0 && bootMs < bootGateMs) {
        result.deferred.push(slot)
        continue
      }

      state.lastFired[key] = now.toISOString()
      result.fired.push(slot)

      // 3) 组装本次该提醒的条目（去重 + 静默）
      for (const reminder of dueReminders(now)) {
        const lastAt = state.lastNotified[reminder.key]
        const dedupeMs = (Number(alarmConfig.dedupeMinutes) || 0) * 60_000
        if (lastAt && now.getTime() - new Date(lastAt).getTime() < dedupeMs) {
          result.suppressed.push({ ...reminder, reason: 'dedupe' })
          continue
        }
        state.lastNotified[reminder.key] = now.toISOString()
        result.reminders.push(reminder)
      }
    }

    // 4) 静默时段：算归算，但标记"不弹"
    if (inQuietHours(now, alarmConfig.quietHours)) {
      result.suppressed.push({ reason: 'quiet', count: result.reminders.length })
      result.reminders = []
    }

    // 5) 清理过期去重记录（保留 7 天），防止文件无限长
    prune(state.lastNotified, now, 7)
    prune(state.lastFired, now, 7)
    persist()
    return result
  }

  return { tick, dueReminders, state }
}

/* ── 小工具 ─────────────────────────────────────────────── */

function safeStats(ledger) {
  try {
    return ledger.stats()
  } catch {
    return { confirmed: [] }
  }
}

export function inQuietHours(now, quiet) {
  if (!quiet || !isClock(quiet.from) || !isClock(quiet.to)) return false
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const from = minutesOf(quiet.from)
  const to = minutesOf(quiet.to)
  if (from === to) return false
  return from < to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to
}

function dateOf(now) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function prune(map, now, keepDays) {
  const limit = now.getTime() - keepDays * 86400000
  for (const key of Object.keys(map)) {
    const at = map[key]
    const time = typeof at === 'string' ? new Date(at).getTime() : NaN
    if (Number.isFinite(time) && time < limit) delete map[key]
  }
}
