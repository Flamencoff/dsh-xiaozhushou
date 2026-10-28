/**
 * 史官记录（M3 落盘）
 *
 * 一次「记一笔」的完整动作：
 *   1) 读增量事件（只读：sessionQuery → session-source）
 *   2) 按档位/预算/脱敏/排除筛选（core/read.js）
 *   3) 事件指纹去重（core/cursor.js），游标只进不退
 *   4) 写成人读的言行录 md（`<dataDir 的上级>\史官\言行录\YYYY-MM\YYYY-MM-DD.md`，只追加）
 *
 * 铁律：只记录、不判断、不建议；每条都带引用；写不进去要报人话，不假装成功。
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { selectEvents } from './read.js'
import { fingerprintOf } from './cursor.js'

export function createHistorian({ dataDir, store, cursor, source, config, memory }) {
  const historianRoot = join(dirname(dataDir), '史官')

  function enabled() {
    return Boolean(config && config.enabled && config.enabled.historian)
  }

  /**
   * @param {{sessionId?:string, scope?:'session'|'all', tier?:string, dryRun?:boolean, now?:Date}} request
   */
  async function recordOnce(request = {}) {
    if (!enabled()) {
      return {
        ok: false,
        code: 'historian_disabled',
        message: '史官现在是关闭的（enabled.historian=false）。发布默认是开启的；要开就在配置里打开——涉密环境请保持关闭或改 sandbox 范围。',
      }
    }

    const now = request.now instanceof Date ? request.now : new Date()
    const tier = request.tier || (config.historian && config.historian.tier) || 'summary'
    const budgets = (config.historian && config.historian.budgets) || {}
    const exclude = (config.historian && config.historian.exclude) || []
    const reduceAuthor = !(config.privacy && config.privacy.reduceAuthorGranularity === false)

    // 1) 定目标
    let targets = []
    if (request.sessionId) {
      targets = [{ sessionId: request.sessionId }]
    } else {
      const listed = await source.listTargets({ limit: 50 })
      if (!listed.ok) return { ok: false, code: listed.code, message: listed.message, written: 0 }
      targets = listed.targets
    }
    // D-05/06：发布默认 mode=all（读真实会话）；sandbox 时只读 [实验] 前缀 + 三个角色会话
    const scope = (config.historian && config.historian.scope) || { mode: 'all', prefixes: ['[实验]'] }
    let filteredByScope = 0
    if (scope.mode !== 'all' && !request.sessionId) {
      const prefixes = Array.isArray(scope.prefixes) && scope.prefixes.length ? scope.prefixes : ['[实验]']
      const before = targets.length
      targets = targets.filter((target) => {
        const title = String(target.title || '')
        if (prefixes.some((prefix) => title.startsWith(prefix))) return true
        // 2026-10-26：角色会话（秘书/CEO/史官）也算"可读"，这样秘书交代的事史官能接住
        return title.startsWith('dsh小助手 · ')
      })
      filteredByScope = before - targets.length
    }
    if (!targets.length) return { ok: true, written: 0, skippedDuplicates: 0, filteredByScope, message: filteredByScope ? 'sandbox 范围下没有标题以 ' + ((scope.prefixes || []).join('/')) + ' 开头的测试会话（也不含角色会话）；要读真实会话把 historian.scope.mode 设为 all' : '没有可读的会话' }

    const perSession = []
    let written = 0
    let skippedDuplicates = 0
    let truncatedSessions = 0
    let failedSessions = 0

    for (const target of targets) {
      const cursorKey = `session:${target.sessionId}`
      const sinceSeq = cursor.get(cursorKey)
      const read = await source.readEvents(target.sessionId, { sinceSeq })
      if (!read.ok) {
        failedSessions += 1
        perSession.push({ sessionId: target.sessionId, ok: false, code: read.code, message: read.message })
        continue
      }
      if (!read.events.length) {
        perSession.push({ sessionId: target.sessionId, ok: true, records: 0, reason: 'no_new_events' })
        continue
      }

      const selected = selectEvents(read.events, { tier, budgets, exclude, reduceAuthorGranularity: reduceAuthor, now: now.getTime() })
      if (selected.stats.truncated) truncatedSessions += 1

      const fresh = []
      const freshPrints = []
      for (const record_ of selected.records) {
        const print = fingerprintOf(target.sessionId, record_.refs.seq, record_.text)
        if (request.dryRun) {
          if (cursor.hasSeen(print)) {
            skippedDuplicates += 1
            continue
          }
          fresh.push(record_)
          continue
        }
        // 非 dryRun：先收下，等写盘成功后再统一记指纹（FIX-22）
        if (cursor.hasSeen(print)) {
          skippedDuplicates += 1
          continue
        }
        freshPrints.push(print)
        fresh.push(record_)
      }

      if (fresh.length) {
        if (!request.dryRun) {
          const file = join(historianRoot, '言行录', monthOf(now), `${dayOf(now)}.md`)
          const ok = appendRecords(file, dayOf(now), fresh, target)
          if (!ok) {
            failedSessions += 1
            perSession.push({ sessionId: target.sessionId, ok: false, code: 'write_failed', message: '言行录写不进去：' + file })
            continue
          }
          for (const print of freshPrints) cursor.markSeen(print)
        }
        written += fresh.length
      }

      if (selected.nextCursor !== null && !request.dryRun) {
        cursor.advance(cursorKey, selected.nextCursor, now.toISOString())
      }
      perSession.push({
        sessionId: target.sessionId,
        ok: true,
        records: fresh.length,
        skipped: selected.stats.skippedByType + selected.stats.skippedByWindow + selected.stats.skippedByExclude,
        redacted: selected.stats.redacted,
        truncated: selected.stats.truncated,
      })
    }

    // D-19：史官真跑完（非 dryRun）触发长期记忆周更；不是到期就跳过，不影响记录结果
    let memoryUpdate = null
    if (memory && typeof memory.maybeWeeklyUpdate === 'function' && !request.dryRun) {
      try {
        memoryUpdate = memory.maybeWeeklyUpdate({ reason: 'historian' })
      } catch (error) {
        memoryUpdate = { ok: false, code: 'memory_failed', message: messageOf(error) }
      }
    }

    return {
      ok: failedSessions === 0,
      tier,
      dryRun: Boolean(request.dryRun),
      written,
      skippedDuplicates,
      filteredByScope,
      truncatedSessions,
      failedSessions,
      root: historianRoot,
      sessions: perSession,
      memory: memoryUpdate,
      message: failedSessions ? `有 ${failedSessions} 个会话没读成，其余照常` : `记了 ${written} 条`,
    }
  }

  let running = false
  async function record(request = {}) {
    if (running) return { ok: false, code: 'busy', message: '史官正在读，等这次跑完再试' }
    running = true
    try {
      return await recordOnce(request)
    } finally {
      running = false
    }
  }

  return { record, historianRoot, enabled }
}

/* ── 落盘 ───────────────────────────────────────────────── */

function appendRecords(file, day, records, target) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const lines = records.map((record_) => {
      const time = clockOf(record_.refs.time)
      const who = record_.kind === 'user' ? '用户' : record_.kind === 'reply' ? 'AI' : record_.kind === 'tool' ? '工具' : record_.kind === 'tool-result' ? '结果' : '思考'
      const text = String(record_.text || '').replace(/\r?\n/g, ' ').slice(0, 300)
      return `- ${time} ${who}：${text} [来源: ${target.sessionId}#${record_.refs.seq} @${new Date(record_.refs.time).toISOString()}]`
    })
    const header = existsSync(file)
      ? ''
      : `# 言行录 · ${day}\n\n> 史官只记录、不判断；每条带引用（会话#事件序号 @时间）。\n\n`
    appendFileSync(file, header + lines.join('\n') + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function monthOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function dayOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function clockOf(time) {
  const d = new Date(Number(time) || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}
