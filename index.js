/**
 * dsh小助手（dsh-xiaozhushou）· 宿主半（Host）
 *
 * M1 职责：
 *   1) 4 条路由：/state（浮窗轮询）、/board（整页看板）、/command（确认/划掉/完成）、/health；
 *   2) 台账真落盘（待办.json，带状态机）；会话元数据只读采集（采集.json，不读内容）；
 *   3) 每 60s 零成本重算 + 启动先算一次（不调模型、不花钱）；
 *   4) 所有资源在 ctx.effect 里注册并返回清理；任何异常都只降级、不拖垮宿主。
 *
 * 明确不做（留给后面）：不读会话内容、不建会话、不调模型、不注册工具与 preset。
 */

import { readPointer, resolveDataDir, writePointer } from './core/paths.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createAudit } from './core/audit.js'
import { createStore } from './core/store.js'
import { createLedger } from './core/ledger.js'
import { createInbox } from './core/inbox.js'
import { createAlarm, inQuietHours } from './core/alarm.js'
import { createCursor } from './core/cursor.js'
import { createSessionSource } from './core/session-source.js'
import { createHistorian } from './core/historian.js'
import { fourQuestions, singleLine } from './core/analysis.js'
import { createHandover } from './core/handover.js'
import { computePriority } from './core/priority.js'
import { createToolset, runCeoAnalysis } from './core/tools.js'
import { createRoleChat } from './core/role-chat.js'
import { detectTaskIntent, taskIntentLabel } from './core/task-intent.js'
import { writeHistorianFeed } from './core/historian-feed.js'
import { createMemory } from './core/memory.js'
import { createCeoExecutor, detectExecuteIntent } from './core/ceo-execute.js'
import { presetDefinitions } from './roles/presets.js'
import { createPush } from './core/push.js'
import { createSpawner } from './core/spawn.js'
import { createBrain } from './core/brain.js'
import { createNotifier } from './core/notify.js'
import { createFinder } from './core/find.js'
import { shouldWakeModel } from './core/escalate.js'
import { writeRepairStation } from './core/repair.js'
import { resolveConfig } from './core/config.js'
import { collect } from './core/collect.js'
import { buildState, buildBoard } from './core/board.js'
import { createTaskFlow } from './core/task-flow.js'
import { candidatesFromEvents } from './core/session-scan.js'
import { createHistorianSchedule } from './core/historian-schedule.js'

/** 依赖的宿主服务；缺失时插件不激活。 */
export const inject = ['webServer']

// 版本号单一来源（守卫测试会校验它与 package.json 一致）
const VERSION = '0.47.8'

function readBoardTasks(storeRef) {
  try {
    const data = storeRef.read('任务.json', { version: 1, tasks: [] }) || { version: 1, tasks: [] }
    return Array.isArray(data.tasks) ? data.tasks : []
  } catch {
    return []
  }
}
const ROUTE_PREFIX = '/api/dsh-xiaozhushou'

export function apply(ctx, configIn = {}) {
  const { config, warnings } = resolveConfig(configIn)
  const dataDir = resolveDataDir(ctx, config)
  const audit = createAudit(dataDir)
  const store = createStore(dataDir)
  const ledger = createLedger(store)
  const inbox = createInbox(store)

  const runtime = {
    dataDir,
    // FIX-05：看板要报告"下次提醒/是否静默/推送开关"，从 runtime 读配置
    config,
    computedAt: null,
    degraded: [],
    snapshot: null,
    collectError: null,
    startedAt: new Date().toISOString(),
    dueReminders: [],
    lastAlarm: null,
    configWarnings: warnings,
    config,
  }

  const alarm = createAlarm({ store, config, ledger, startedAt: runtime.startedAt })
  const cursor = createCursor(store)
  const source = createSessionSource(ctx)
  // D-19：长期记忆四文件（<dataDir>/记忆/），史官周更，秘书/CEO 只读摘要
  const memory = createMemory({ store, dataDir })
  memory.ensure()
  const historian = createHistorian({ dataDir, store, cursor, source, config, memory })
  const handover = createHandover({ dataDir })
  const pusher = createPush({ ctx, config, audit, log, store })
  const spawner = createSpawner(ctx)
  // D-20 ②："开新会话执行 …" → 真建 steward-ceo 会话（复用 spawner 的 create→rename→prompt）
  const ceoExecutor = createCeoExecutor({ spawner })
  const taskFlow = createTaskFlow({ dataDir })
  const brain = createBrain({ ctx, config, log })
  const notifier = createNotifier({ dataDir })
  const finder = createFinder({ config, dataDir, log })
  // 角色聊天只走绑定的真实会话（D-01）：拿不到回复就显式报错，不再直连模型兜底。
  // 模型只保留给 CEO 分析、史官摘要等非聊天路径（brain 仍注入 tools.js）。
  const secretaryChat = createRoleChat({ ctx, store, log, dataDir, role: 'secretary', ledger, memory })
  const ceoRoleChat = createRoleChat({ ctx, store, log, dataDir, role: 'ceo', ledger, memory })
  const historianChat = createRoleChat({ ctx, store, log, dataDir, role: 'historian', ledger, memory })
  const historianSchedule = createHistorianSchedule({ dataDir, historian, historianChat, config, audit, log })

  /** 转交任务后真的送一条消息进 CEO 会话；失败必须让调用方知道 */
  async function notifyCeoHandoff(task, facts, fromRole) {
    const explicitNew = task && task.explicitNew === true
    const text =
      '转交任务 ' + task.id + '：' + task.title + '\n背景：' + String(facts || '').slice(0, 800) +
      (explicitNew
        ? '\n这是用户明确要开的新任务：请开任务会话。'
        : '\n这不是明确要新建：先按标题/会话号搜旧会话；找到用 send_session 发进去；找不到先问用户是哪个会话、要不要新建，不要直接开会话。')
    let result
    try {
      result = await ceoRoleChat.notice(text)
    } catch (error) {
      result = { ok: false, message: String(error && error.message ? error.message : error) }
    }
    const ok = Boolean(result && result.ok)
    audit.write({ role: fromRole, action: 'handoff:notice', target: task.id, result: ok ? 'ok' : 'failed', reason: ok ? '' : String((result && result.message) || 'notice_failed').slice(0, 120) })
    return { ok, message: ok ? '' : String((result && result.message) || 'CEO 会话没接住') }
  }

  /** 一键建好三个角色会话并绑定（接口与启动自动初始化共用；已存在则复用） */
  async function bootstrapRoles() {
    const controller = safeGet(ctx, 'sessionController')
    if (!controller || typeof controller.create !== 'function') {
      return { ok: false, code: 'no_controller', message: '这个环境不支持自动建会话', results: [] }
    }
    const roleConf = [
      { role: 'secretary', title: 'dsh小助手 · 秘书 对话', preset: 'steward-secretary', dir: '秘书', chat: secretaryChat },
      { role: 'ceo', title: 'dsh小助手 · CEO 对话', preset: 'steward-ceo', dir: 'CEO', chat: ceoRoleChat },
      { role: 'historian', title: 'dsh小助手 · 史官 对话', preset: 'steward-historian', dir: '史官', chat: historianChat },
    ]
    const results = []
    for (const conf of roleConf) {
      try {
        const state = store.read(conf.dir + '/会话状态.json', { version: 1, sessionId: null, lastSeq: 0 }) || {}
        const existing = state.sessionId ? String(state.sessionId) : ''
        let sessionId = existing
        if (!sessionId) {
          const created = await controller.create({ agentPreset: conf.preset })
          sessionId = created && created.sessionId
          if (sessionId && typeof controller.rename === 'function') {
            try { await controller.rename({ sessionId, title: conf.title }) } catch {}
          }
        }
        if (sessionId) {
          store.write(conf.dir + '/会话状态.json', {
            version: 1,
            sessionId,
            lastSeq: Number(state.lastSeq) || 0,
            title: conf.title,
            boundBy: 'bootstrap',
            updatedAt: new Date().toISOString(),
          })
        }
        results.push({ role: conf.role, sessionId, title: conf.title, created: !existing })
      } catch (error) {
        results.push({ role: conf.role, error: String(error && error.message ? error.message : error) })
      }
    }
    audit.write({ role: 'core', action: 'roles:bootstrap', target: results.map((item) => item.role).join(','), result: 'ok' })
    return { ok: true, results }
  }


  function log(message) {
    audit.write({ role: 'core', action: 'log', target: String(message).slice(0, 200), result: 'ok' })
  }

  function view() {
    return { ...runtime, ledger, inbox }
  }

  // 注册期（工具/preset/定时器）发生的降级是"常驻"的，重算不能把它抹掉（2026-10-26 修 A-04）
  const persistentDegraded = new Set()
  function markDegraded(name) {
    if (name) persistentDegraded.add(name)
  }

  /** 看板上的“史官今天记了多少”：直接读当天言行录，重启后也不会显示“还没跑过” */
  function historianToday() {
    try {
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const file = join(historian.historianRoot, '言行录', y + '-' + m, y + '-' + m + '-' + d + '.md')
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.startsWith('- '))
      return { summary: '今天已记 ' + lines.length + ' 条（' + y + '-' + m + '-' + d + '）', did: [], decided: [], followups: [] }
    } catch {
      return { summary: '今天还没跑史官：点「真跑一次（写盘）」才会记录', did: [], decided: [], followups: [] }
    }
  }

  function recompute() {
    runtime.computedAt = new Date().toISOString()
    runtime.degraded = Array.from(persistentDegraded)
    if (store.lastError) runtime.degraded.push('store')
    if (runtime.collectError) runtime.degraded.push('collect')
    if (runtime.configWarnings && runtime.configWarnings.length) runtime.degraded.push('config')
    // 2026-10-26 修 B-3：把"现在是不是静默时段"传给浮窗，鲸鱼娘才会在夜里打瞌睡
    try {
      runtime.quiet = inQuietHours(new Date(), config.alarm && config.alarm.quietHours)
    } catch {
      runtime.quiet = false
    }
    runtime.historianToday = historianToday()
  }


  // 每周归档：方便做周报
  function isoWeekKey(now) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    const day = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() + 4 - day)
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
    return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
  }

  function maybeArchiveWeek(now = new Date()) {
    try {
      const week = isoWeekKey(now)
      const state = store.read('归档状态.json', { version: 1, lastWeek: '' })
      if (state && state.lastWeek === week) return
      const result = ledger.archiveWeek(now)
      if (!result || !result.ok) {
        audit.write({ role: 'core', action: 'archive:week', target: week, result: 'failed', reason: result ? result.code : 'unknown' })
        return
      }
      store.write('归档状态.json', { version: 1, lastWeek: week, lastAt: now.toISOString(), lastArchived: result.archived || 0 })
      audit.write({ role: 'core', action: 'archive:week', target: week, result: 'ok', reason: 'archived=' + (result.archived || 0) })
      if (result.archived) log('archived ' + result.archived + ' items to 台账归档/' + week + '.md')
    } catch (error) {
      log('archive failed: ' + String(error && error.message ? error.message : error))
    }
  }

  async function refresh() {
    maybeArchiveWeek(new Date())
    try {
      const snapshot = await collect(ctx, store, log)
      runtime.snapshot = snapshot
      runtime.collectError = snapshot.ok ? null : snapshot.message || 'collect failed'
    } catch (error) {
      runtime.collectError = String(error && error.message ? error.message : error)
    }
    try {
      try {
      const nowForAnalysis = new Date()
      runtime.four = fourQuestions({ ledger, snapshot: runtime.snapshot, now: nowForAnalysis })
      runtime.analysis = singleLine({ ledger, snapshot: runtime.snapshot, now: nowForAnalysis })
    } catch (error) {
      runtime.four = null
      runtime.analysis = null
      runtime.degraded.push('analysis')
    }
    runtime.lastAlarm = alarm.tick(new Date())
      runtime.dueReminders = runtime.lastAlarm.reminders && runtime.lastAlarm.reminders.length
        ? runtime.lastAlarm.reminders
        : alarm.dueReminders(new Date())
    } catch (error) {
      runtime.dueReminders = []
      runtime.degraded.push('alarm')
      log('alarm failed: ' + String(error && error.message ? error.message : error))
    }
    // FIX-12：闹钟结果进审计（以前到点后审计里查不到任何 alarm 记录）
    try {
      const a = runtime.lastAlarm || {}
      const acted = (a.fired && a.fired.length) || (a.reminders && a.reminders.length) || (a.missed && a.missed.length) || (a.suppressed && a.suppressed.length)
      if (acted) {
        audit.write({
          role: 'core',
          action: 'alarm',
          target: (a.fired || []).join(',') || 'slot',
          result: 'ok',
          reason: 'reminders=' + ((a.reminders || []).length) + ' missed=' + ((a.missed || []).length) + ' suppressed=' + ((a.suppressed || []).length),
        })
      }
    } catch {
      /* 审计失败不影响提醒 */
    }
    recompute()
    try {
      const fired = runtime.lastAlarm && runtime.lastAlarm.fired && runtime.lastAlarm.fired.length
      if (fired && runtime.dueReminders.length) {
        // K1：按复杂度决定要不要叫一次轻量模型，写一句人话开场（失败就退回纯列表）
        let intro = ''
        const wake = shouldWakeModel({ dueReminders: runtime.dueReminders, config })
        runtime.lastWake = wake
        if (wake.wake && brain.available()) {
          const ask = await brain.ask({
            system: '你只写一句话，不超过 30 字，不要列表、不要客套。',
            prompt: '把这些待办压成一句最该先做的话：' + runtime.dueReminders.map((item) => item.title).join('、'),
            maxTokens: 80,
          })
          if (ask.ok) intro = ask.text
        }
        runtime.lastPush = await pusher.push(runtime.dueReminders, new Date(), { intro })
        if (runtime.lastPush && !runtime.lastPush.ok && !runtime.degraded.includes('push')) runtime.degraded.push('push')
      }
    } catch (error) {
      log('push failed: ' + String(error && error.message ? error.message : error))
    }
    try {
      store.write('看板.json', buildBoard(view()))
      store.write('状态.json', buildState(view()))
    } catch {
      /* 落盘失败不影响路由实时计算 */
    }
  }

  // 首装/首启自动建好三角色会话：只在启动时跑一次，不能放进 refresh()，
  // 否则每 60 秒重写一次绑定状态。
  if (!config.roles || config.roles.autoBootstrap !== false) {
    ctx.effect(() => {
      const timer = setTimeout(() => { bootstrapRoles().catch(() => {}) }, 2500)
      return () => clearTimeout(timer)
    })
  }

  // Cordis 里直接访问未 inject 的服务属性会抛错（真机装上去才发现的坑），
  // 所以统一走 ctx.get('timer')：拿不到就降级，不影响其它功能。
  const timerService = safeGet(ctx, 'timer')
  if (timerService && typeof timerService.interval === 'function') {
    ctx.effect(() => timerService.interval(() => {
      refresh().catch((error) => log('refresh failed: ' + String(error && error.message ? error.message : error)))
      historianSchedule.check().then(() => recompute()).catch((error) => log('historian schedule failed: ' + String(error && error.message ? error.message : error)))
    }, 60_000))
    // 启动后 15 秒补跑错过的节律（关机/没开 DSH 时错过 21:45 的情况）
    ctx.effect(() => {
      const timer = setTimeout(() => {
        historianSchedule.check().then(() => recompute()).catch((error) => log('historian schedule startup failed: ' + String(error && error.message ? error.message : error)))
      }, 15_000)
      return () => clearTimeout(timer)
    })
    runtime.timerRegistered = true
  } else {
    runtime.timerRegistered = false
    markDegraded('timer')
  }

  // A1：三个角色工具（默认注册；config.tools.enabled=false 可整体关掉）
  if (config.tools && config.tools.enabled) {
    const toolService = safeGet(ctx, 'tools')
    if (toolService && typeof toolService.register === 'function') {
      try {
        const taskOps = {
        list: () => ceoRoleChat.readTasks(),
        assign: (title, facts, explicitNew) => secretaryChat.assignTask({ title, assignee: 'ceo', by: 'secretary', facts, explicitNew }),
        setStatus: (id, status, options) => ceoRoleChat.setTaskStatus(id, status, options),
        patch: (id, fields) => ceoRoleChat.patchTask(id, fields),
        writeHandoff: (task, sessionId) => taskFlow.writeHandoff({ task, sessionId }),
        archive: (id) => {
          const task = ceoRoleChat.readTasks().find((item) => item.id === id)
          if (!task) return { ok: false, message: '没找到 ' + id }
          if (!['完成', '已记忆'].includes(task.status)) return { ok: false, message: '任务还没完成，先完成再归档' }
          try {
            const card = taskFlow.writeArchive({ task })
            const changed = ceoRoleChat.setTaskStatus(id, '已归档', { assignee: 'secretary' })
            if (!changed || !changed.ok) return changed
            const patched = ceoRoleChat.patchTask(id, { archivedPath: card.ok ? card.path : '' })
            return { ...patched, text: card.ok ? '归档 ' + card.path : '状态已归档，归档文件没写成：' + card.message }
          } catch (error) {
            return { ok: false, message: '归档失败：' + String(error && error.message ? error.message : error) }
          }
        },
        remember: (id) => {
          const task = ceoRoleChat.readTasks().find((item) => item.id === id)
          if (!task) return { ok: false, message: '没找到 ' + id }
          if (!['完成', '已归档'].includes(task.status)) return { ok: false, message: '任务还没完成，先完成再存为记忆' }
          try {
            const feed = writeHistorianFeed({ dataDir, task })
            const changed = ceoRoleChat.setTaskStatus(id, '已记忆', { assignee: 'historian' })
            if (!changed || !changed.ok) return changed
            const patched = ceoRoleChat.patchTask(id, { memoryPath: feed.file })
            return { ...patched, text: '记忆卡 ' + feed.file }
          } catch (error) {
            return { ok: false, message: '存为记忆失败：' + String(error && error.message ? error.message : error) }
          }
        },
      }
      const sessionOps = {
        list: async (query = '') => {
          const keyword = String(query || '').trim()
          const fallback = Array.isArray(runtime.snapshot && runtime.snapshot.sessions) ? runtime.snapshot.sessions : []
          let rows = fallback
          const queryService = safeGet(ctx, 'sessionQuery')
          if (queryService && typeof queryService.listSessions === 'function') {
            try {
              const records = await queryService.listSessions()
              const sliced = (Array.isArray(records) ? records : []).slice(0, 500)
              const ids = sliced.map((row) => row && row.header && row.header.id).filter(Boolean)
              const titles = new Map()
              if (ids.length && typeof queryService.readTitleSnapshots === 'function') {
                try {
                  for (const item of (await queryService.readTitleSnapshots(ids)) || []) {
                    if (item && item.status === 'fulfilled' && item.value && item.value.title) titles.set(item.sessionId, item.value.title.title)
                  }
                } catch {}
              }
              rows = sliced.map((row) => ({
                id: String((row && row.header && row.header.id) || ''),
                title: String(titles.get(row && row.header && row.header.id) || ''),
                live: Boolean(row && row.live),
                preset: String((row && row.header && row.header.agentPreset) || ''),
              }))
            } catch {}
          }
          return rows
            .filter((row) => row.id)
            .filter((row) => !keyword || String(row.title || '').includes(keyword) || String(row.id).includes(keyword))
            .slice(0, 20)
        },
        scan: async (limit = 8) => {
          const queryService = safeGet(ctx, 'sessionQuery')
          if (!queryService || typeof queryService.listSessions !== 'function' || typeof queryService.readSession !== 'function') return { ok: false, message: '这个环境读不到会话' }
          let records = []
          try { records = (await queryService.listSessions()) || [] } catch (error) { return { ok: false, message: '读会话列表失败：' + String(error && error.message ? error.message : error) } }
          const found = []
          for (const record of records.slice(0, Math.max(1, Math.min(30, Number(limit) || 8)))) {
            const id = record && record.header && record.header.id
            if (!id) continue
            try {
              const snapshot = await queryService.readSession(id)
              const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : []
              found.push(...candidatesFromEvents(events, { sessionId: id, max: 2 }))
            } catch {}
          }
          const seen = new Set()
          const unique = found.filter((item) => {
            const key = item.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
            if (!key || seen.has(key)) return false
            seen.add(key)
            return true
          })
          return { ok: true, candidates: unique.slice(0, 10) }
        },
        prompt: async (sessionId, text) => {
          const id = String(sessionId || '').trim()
          if (!id) return { ok: false, message: '给个会话 id' }
          const controller = safeGet(ctx, 'sessionController')
          if (!controller || typeof controller.prompt !== 'function') return { ok: false, message: '这个环境不能给会话发消息' }
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(), 30_000)
          try {
            await controller.prompt(
              { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: String(text || '').slice(0, 4000) }] },
              abort.signal,
            )
            return { ok: true }
          } catch (error) {
            return { ok: false, message: '没发进去：' + String(error && error.message ? error.message : error) }
          } finally {
            clearTimeout(timer)
          }
        },
      }
      const toolset = createToolset({ ledger, inbox, historian, handover, config, snapshot: () => runtime.snapshot, spawner, brain, notifier, finder, pusher, tasks: taskOps, taskFlow, roleChats: { secretary: secretaryChat, ceo: ceoRoleChat, historian: historianChat }, sessions: sessionOps, log })
        for (const definition of toolset) {
          ctx.effect(() => toolService.register(definition))
        }
        runtime.toolsRegistered = toolset.map((definition) => definition.name)
      } catch (error) {
        markDegraded('tools')
        log('tools register failed: ' + String(error && error.message ? error.message : error))
      }
    } else {
      markDegraded('tools')
    }
  }

  // N-2：三个角色 preset（默认注册；preset 决定会话身份与工具面）
  if (config.roles && config.roles.registerPresets) {
    const presets = safeGet(ctx, 'agentPresets')
    if (presets && typeof presets.register === 'function') {
      for (const definition of presetDefinitions()) {
        try {
          ctx.effect(() => presets.register(definition))
          runtime.degraded = runtime.degraded || []
        } catch (error) {
          markDegraded('presets')
          log('preset register failed: ' + definition.id + ' ' + String(error && error.message ? error.message : error))
        }
      }
      runtime.presetsRegistered = presetDefinitions().map((definition) => definition.id)
    } else {
      markDegraded('presets')
    }
  }

  ctx.effect(() => {
    const disposers = []

  // 皮肤资源：浏览器端只能通过 HTTP 拿图片，插件包内的 assets 由宿主发出去
  const ASSET_DIR = new URL('./assets/', import.meta.url)
  const PET_FILE = new URL('./assets/pet/pet.png', import.meta.url)

  // 宿主连接准入：所有 API 路由先过 Connection 的 Host/Origin + 浏览器认证。
  // 认证服务不可用时直接拒绝，不能只靠 Origin 判断。
  const rawRegister = ctx.webServer.register.bind(ctx.webServer)
  function guardedRegister(route) {
    const original = route.handler
    return rawRegister({
      ...route,
      handler: async (req, res) => {
        const connection = safeGet(ctx, 'connection')
        if (!connection || typeof connection.requestRejection !== 'function') {
          return sendJson(res, 401, { ok: false, code: 'connection_unavailable', message: '宿主认证不可用，已拒绝访问' })
        }
        let rejection
        try {
          rejection = connection.requestRejection({ headers: (req && req.headers) || {} })
        } catch {
          return sendJson(res, 401, { ok: false, code: 'connection_rejected', message: '宿主连接准入失败，已拒绝访问' })
        }
        if (rejection) {
          return sendJson(res, rejection, { ok: false, code: 'connection_rejected', message: '需要已认证的 DSH 连接' })
        }
        return original(req, res)
      },
    })
  }

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: (_req, res) => {
          const openTasks = ceoRoleChat.readTasks().filter((task) => task.status === '待办' || task.status === '进行中')
          const state = buildState({ ...view(), openTasks, allTasks: openTasks.length ? ceoRoleChat.readTasks() : [] })
          state.tasks = openTasks
            .filter((task) => !['完成', '已归档', '已记忆', '已作废'].includes(task.status))
            .sort((a, b) => ((b.priority && b.priority.level) || 0) - ((a.priority && a.priority.level) || 0))
            .slice(0, 6)
            .map((task) => ({ id: task.id, title: task.title, status: task.status, priority: task.priority || null }))
          sendJson(res, 200, state)
        },
      }),
    )

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/board`,
        handler: (_req, res) => {
          const tasks = ceoRoleChat.readTasks()
          const openTasks = tasks.filter((task) => task.status === '待办' || task.status === '进行中')
          sendJson(res, 200, Object.assign({}, buildBoard({ ...view(), openTasks, allTasks: tasks }), { tasks }))
        },
      }),
    )

    // 皮肤资源：浏览器只能通过 HTTP 取图，插件自带的 assets 由宿主发出去
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/asset/pet`,
        handler: (_req, res) => {
          try {
            const buffer = readFileSync(fileURLToPath(new URL('./assets/pet/pet.png', import.meta.url)))
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache, max-age=0' })
            res.end(buffer)
          } catch (error) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, code: 'asset_missing', message: '皮肤图不存在' }))
          }
        },
      }),
    )
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/asset/tail`,
        handler: (_req, res) => {
          try {
            const buffer = readFileSync(fileURLToPath(new URL('./assets/pet/tail.png', import.meta.url)))
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache, max-age=0' })
            res.end(buffer)
          } catch (error) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, code: 'asset_missing' }))
          }
        },
      }),
    )

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/health`,
        handler: (_req, res) => {
          const stats = safeCall(() => ledger.stats(), { confirmed: [], pendingCount: 0 })
          const checks = [
            { name: 'dataDir', ok: Boolean(dataDir), detail: dataDir },
            // 2026-10-26 修 A-04：以前看 computedAt（永远非空）→ 恒真，等于没检查。现在看定时器是否真注册。
            { name: 'timer', ok: Boolean(runtime.timerRegistered), detail: runtime.timerRegistered ? '已注册' : '没注册（自动刷新/定点提醒不会跑）' },
            { name: 'store', ok: !store.lastError, detail: store.lastError || '正常' },
            { name: 'collect', ok: Boolean(runtime.snapshot && runtime.snapshot.ok), detail: runtime.collectError || '正常' },
            { name: 'config', ok: !(runtime.configWarnings && runtime.configWarnings.length), detail: (runtime.configWarnings || []).join('；') || '正常' },
          ]
          const now = new Date()
          const quiet = inQuietHours(now, config.alarm && config.alarm.quietHours)
          sendJson(res, 200, {
            ok: checks.every((check) => check.ok),
            version: VERSION,
            startedAt: runtime.startedAt,
            computedAt: runtime.computedAt,
            degraded: runtime.degraded,
            todos: { confirmed: stats.confirmed.length, pending: stats.pendingCount },
            inbox: { open: safeCall(() => inbox.list({ status: 'open' }).length, 0), skipped: inbox.skipped },
            repairStation: runtime.repairPath || null,
            tools: { enabled: Boolean(config.tools && config.tools.enabled), registered: runtime.toolsRegistered || [] },
            presets: { enabled: Boolean(config.roles && config.roles.registerPresets), registered: runtime.presetsRegistered || [] },
            push: {
      enabled: Boolean(config.alarm && config.alarm.push && config.alarm.push.enabled),
      sandbox: Boolean(config.sandbox && config.sandbox.enabled),
      sandboxPrefix: (config.sandbox && config.sandbox.sessionTitlePrefix) || '',
      // FIX-12：优先读落盘状态，push_now 手动推的那次也能看到
      last: runtime.lastPush || safeCall(() => store.read('推送状态.json', null), null),
    },
            model: { enabled: Boolean(config.model && config.model.enabled), available: brain.available(), current: brain.currentModel(), maxTokens: config.model && config.model.maxTokens },
            wake: runtime.lastWake || null,
            find: { roots: finder.allowedRoots },
            handoverRoot: handover.root,
            memory: {
              root: memory.root,
              files: memory.files.map((file) => file.name),
              lastUpdatedAt: memory.status().lastUpdatedAt || null,
              note: '四文件周更（史官跑完触发）；秘书/CEO 只读片段，不整篇塞',
            },
            historian: {
              enabled: Boolean(config.enabled && config.enabled.historian),
              tier: (config.historian && config.historian.tier) || 'summary',
              root: historian.historianRoot,
              note: '0.47.0 发布默认开启，scope.mode=all 可读真实会话；想隐私优先就改 historian.scope.mode=sandbox（只读 [实验] 与角色会话）',
            },
            privacy: {
              reduceAuthorGranularity: Boolean(config.privacy && config.privacy.reduceAuthorGranularity),
              note: 'true=发布版口径（用户内容只记摘要）；自用想留原话就改 false',
            },
            alarm: {
              fixedTimes: (config.alarm && config.alarm.fixedTimes) || [],
              lightModel: (config.alarm && config.alarm.lightModel) || null,
              quiet,
              dueReminders: runtime.dueReminders.length,
              last: runtime.lastAlarm
                ? { fired: runtime.lastAlarm.fired, deferred: runtime.lastAlarm.deferred, merged: runtime.lastAlarm.merged, suppressed: runtime.lastAlarm.suppressed.length }
                : null,
            },
            sessions: runtime.snapshot ? { total: runtime.snapshot.total, live: countLive(runtime.snapshot) } : null,
            checks,
          })
        },
      }),
    )
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/command`,
        handler: async (req, res) => {
          // 2026-10-26 修：写接口只接受 POST，且坏 JSON 要明确报 invalid_json（以前被当成空对象）
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const text = String((body && body.text) || '').trim()
          const result = applyCommand(ledger, text)
          audit.write({
            role: 'user',
            action: 'command',
            target: text.slice(0, 80),
            result: result.ok ? 'ok' : 'rejected',
            reason: result.ok ? '' : result.code,
          })
          recompute()
          sendJson(res, 200, result)
        },
      }),
    )

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/todo`,
        handler: async (req, res) => {
          // 2026-10-26 修：写接口只接受 POST，且坏 JSON 要明确报 invalid_json（以前被当成空对象）
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          // 用户定：界面只传"紧急/重要"两个勾（可同时勾）；
          // "最紧急/最重要"只认用户口述（走 /command 的文字），接口层不接受来自界面的 most*
          const result = ledger.add({
            title: body && body.title,
            due: body && body.due,
            urgency: body && (body.urgent === true || body.urgency === 3) ? 3 : 1,
            importance: body && (body.important === true || body.importance === 3) ? 3 : 1,
            source: { kind: 'user', at: new Date().toISOString() },
          })
          audit.write({
            role: 'user',
            action: 'todo:add',
            target: String((body && body.title) || '').slice(0, 60),
            result: result.ok ? 'ok' : 'rejected',
            reason: result.ok ? '' : result.code,
          })
          recompute()
          sendJson(res, 200, result.ok ? { ...result, priority: computePriority(result.item) } : result)
        },
      }),
    )

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/datadir`,
        handler: async (req, res) => {
          // H-1：让用户手动指定数据目录（不改代码、不改 profile）
          if (req.method === 'GET') return sendJson(res, 200, { ok: true, dataDir })
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '改数据目录请用 POST，带 {"path": "..."}' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const rawWanted = String((body && body.path) || '').trim()
          if (!rawWanted) return sendJson(res, 200, { ok: false, code: 'empty_path', message: '给一个绝对路径，例如 D:\\你的目录\\dsh-xiaozhushou' })
          // 2026-10-26 修 R-03：先校验"用户原串"再 resolve。以前先 resolve 再校验，
          // 相对路径会被解析成绝对路径后混过检查（等于没拦住）。
          if (!/^[A-Za-z]:[\\/]|^\\\\|^\//.test(rawWanted)) {
            return sendJson(res, 200, { ok: false, code: 'not_absolute', message: '要给绝对路径（带盘符的那种），别给相对路径' })
          }
          const wanted = resolve(rawWanted)
          try {
            mkdirSync(wanted, { recursive: true })
            writeFileSync(join(wanted, '.write-test'), 'ok', 'utf8')
            rmSync(join(wanted, '.write-test'), { force: true })
          } catch (error) {
            return sendJson(res, 200, { ok: false, code: 'not_writable', message: '这个目录写不进去（可能没权限或路径不存在），换一个目录试试' })
          }
          const wrote = writePointer(wanted)
          audit.write({ role: 'user', action: 'datadir:set', target: wanted.slice(0, 80), result: wrote ? 'ok' : 'failed' })
          sendJson(res, 200, {
            ok: wrote,
            dataDir: wanted,
            message: wrote ? '已记住这个目录。重启 DSH 后生效（插件启动时才读它）。' : '目录可用，但指针写不进去（检查家目录权限）',
          })
        },
      }),
    )

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/handover`,
        handler: async (req, res) => {
          // 2026-10-26 修：写接口只接受 POST，且坏 JSON 要明确报 invalid_json（以前被当成空对象）
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const result = handover.create({
            topic: body && body.topic,
            workspace: body && body.workspace,
            initiator: body && body.initiator,
            task: body && body.task,
            progress: body && body.progress,
            files: body && body.files,
            next: body && body.next,
            rules: body && body.rules,
            forbidden: body && body.forbidden,
            changed: body && body.changed,
            confirmedQa: body && body.confirmedQa,
            unfinished: body && body.unfinished,
            write: Boolean(body && body.write),
          })
          audit.write({
            role: 'ceo',
            action: body && body.write ? 'handover:write' : 'handover',
            target: String(result.topic || 'unknown').slice(0, 60),
            result: result.ok ? 'ok' : 'failed',
            reason: result.ok ? '' : result.code || '',
          })
          sendJson(res, 200, body && body.includeLedger === false ? { ok: result.ok, card: result.card } : result)
        },
      }),
    )

    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/historian/run`,
        handler: async (req, res) => {
          // 2026-10-26 修：写接口只接受 POST，且坏 JSON 要明确报 invalid_json（以前被当成空对象）
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const result = await historian.record({
            sessionId: body && body.sessionId,
            tier: body && body.tier,
            // FIX-22：HTTP 默认只查不写；要真写必须显式 dryRun:false
            dryRun: body && body.dryRun === false ? false : true,
          })
          recompute()
          audit.write({
            role: 'historian',
            action: 'run',
            target: String((body && (body.sessionId || 'all')) || 'all').slice(0, 80),
            result: result.ok ? 'ok' : 'failed',
            reason: result.ok ? '' : result.code,
          })
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26 新增：看板直接问 CEO（能直观看到模型版/规则版）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/ceo/analyze`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const result = await runCeoAnalysis({ ledger, snapshot: runtime.snapshot, brain })
          audit.write({ role: 'ceo', action: 'analyze', target: 'board', result: result.ok ? 'ok' : 'failed', reason: result.source || '' })
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26 新增：改一条待办（标题/日期）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/todo/edit`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const result = ledger.edit(body && body.id, { title: body && body.title, due: body && body.due })
          audit.write({ role: 'user', action: 'todo:edit', target: String((body && body.id) || ''), result: result.ok ? 'ok' : 'rejected', reason: result.ok ? '' : result.code })
          recompute()
          sendJson(res, 200, result)
        },
      }),
    )

    // 待办操作：调整紧急/重要、改 deadline、划掉=暂停（不是删除）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/todo/update`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const id = String((body && body.id) || '')
          const action = String((body && body.action) || '')
          if (!id) return sendJson(res, 200, { ok: false, code: 'empty', message: '给待办 id' })
          let result
          if (/^K-/.test(id)) {
            const task = ceoRoleChat.readTasks().find((item) => item.id === id)
            if (!task) result = { ok: false, code: 'not_found', message: '没找到 ' + id }
            else if (action === 'adjust') {
              const priority = computePriority({ urgency: body && body.urgency, importance: body && body.importance })
              result = ceoRoleChat.patchTask(id, { urgency: body && body.urgency, importance: body && body.importance, priority })
            } else if (action === 'due') result = ceoRoleChat.patchTask(id, { due: String((body && body.due) || '').slice(0, 10) || null })
            else if (action === 'pause') result = ceoRoleChat.setTaskStatus(id, '已暂停')
            else result = { ok: false, code: 'bad_action', message: '不认识的动作：' + action }
          } else if (action === 'adjust') result = ledger.adjust(id, { urgency: body && body.urgency, importance: body && body.importance })
          else if (action === 'due') result = ledger.edit(id, { due: body && body.due })
          else if (action === 'pause') result = ledger.pause(id)
          else if (action === 'resume') result = ledger.resume(id)
          else result = { ok: false, code: 'bad_action', message: '不认识的动作：' + action }
          audit.write({ role: 'user', action: 'todo:' + action, target: id, result: result.ok ? 'ok' : 'rejected', reason: result.ok ? '' : result.code })
          recompute()
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26 新增：按钮开新会话（点击=用户同意；仍受 4 次/小时限流）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/session/open`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          // D-20/D-08：按钮开会话也要带角色 preset。
          // 历史调用方传的是 `preset`，spawner 的合同字段是 `agentPreset`——这里兼容两种写法，别再丢。
          const result = await spawner.spawn({
            title: body && body.title,
            prompt: body && body.prompt,
            agentPreset: body && (body.agentPreset || body.preset),
            confirmedByAuthor: true,
          })
          audit.write({ role: 'user', action: 'session:open', target: String((body && body.title) || ''), result: result.ok ? 'ok' : 'failed', reason: result.ok ? '' : result.code })
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26 夜：CEO 按钮「开新会话（任务）」——用输入框里的任务真建 steward-ceo 会话
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/ceo/open-task`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) {
            return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          }
          const task = String((body && body.task) || '').trim()
          if (!task) {
            return sendJson(res, 400, { ok: false, code: 'empty_task', message: '先在输入框写清楚要开的任务，再点「开新会话（任务）」' })
          }
          const made = secretaryChat.assignTask({ title: task, assignee: 'ceo', by: 'ceo', facts: '（CEO 按钮开任务会话时自动登记）', explicitNew: true })
          if (!made || !made.ok) {
            return sendJson(res, 200, made || { ok: false, code: 'assign_failed', message: '任务登记失败' })
          }
          const card = taskFlow.writeHandoff({ task: made.task })
          const executed = await ceoExecutor.execute({ task, handoffCard: card.ok ? card.path : '' })
          if (executed.ok) {
            ceoRoleChat.patchTask(made.task.id, { sessionId: executed.sessionId, handoffCard: card.ok ? card.path : '' })
            taskFlow.writeHandoff({ task: { ...made.task, sessionId: executed.sessionId }, sessionId: executed.sessionId })
            executed.taskId = made.task.id
            executed.handoffCard = card.ok ? card.path : ''
          } else {
            ceoRoleChat.patchTask(made.task.id, { status: '待办', spawnError: String(executed.message || 'no_session') })
            executed.taskId = made.task.id
          }
          audit.write({
            role: 'ceo',
            action: 'execute:session:button',
            target: executed.ok ? String(executed.sessionId || '') : 'failed',
            result: executed.ok ? 'ok' : 'failed',
            reason: executed.ok ? task.slice(0, 80) : executed.code,
          })
          sendJson(res, executed.ok ? 200 : (executed.httpStatus || 502), executed)
        },
      }),
    )

    // 角色会话明文同步：看板聊天窗显示 CEO/秘书/史官会话里真正发生过的话
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/role/history`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'GET') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 GET' })
          }
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const role = String(url.searchParams.get('role') || 'ceo')
          const chats = new Map([['secretary', secretaryChat], ['ceo', ceoRoleChat], ['historian', historianChat]])
          const chat = chats.get(role)
          if (!chat) return sendJson(res, 200, { ok: false, code: 'bad_role', message: 'role 只能是 secretary / ceo / historian' })
          const result = await chat.history(30)
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26 新增：CEO 聊天入口（看板右侧直接聊；带问题让模型结合台账回答）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/ceo/chat`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const question = String((body && body.question) || '')
          // D-20 ②：用户说"开新会话执行 …"→ 真的建一个 CEO 预设会话（权限审批由宿主在会话里弹）
          const intent = detectExecuteIntent(question)
          if (intent.matched) {
            const executed = await ceoExecutor.execute({ text: question, task: intent.task })
            audit.write({ role: 'ceo', action: 'execute:session', target: executed.ok ? String(executed.sessionId || '') : 'failed', result: executed.ok ? 'ok' : 'failed', reason: executed.ok ? intent.task.slice(0, 80) : executed.code })
            return sendChat(res, executed)
          }
          // D-20 ①：CEO 聊天里"接下/接手/完成/转交秘书 [K-xxx]"都要真的落到任务板
          // 支持按任务号；没写任务号就取第一条挂给 CEO 的未完成任务；问句不触发
          let taskChange = null
          let autoSession = null
          let noAutoSession = false
          const taskIntent = detectTaskIntent(question)
          if (taskIntent.matched) {
            const tasks = ceoRoleChat.readTasks()
            const special = taskIntent.action === '归档' || taskIntent.action === '存为记忆'
            const target = taskIntent.taskId
              ? tasks.find((task) => String(task.id).toUpperCase() === taskIntent.taskId)
              : special
                ? tasks.filter((task) => task.status === '完成')[0]
                : tasks.filter((task) => task.assignee === 'ceo' && task.status !== '完成')[0]
            if (target) {
              if (special) {
                if (target.status !== '完成') {
                  taskChange = { ok: false, message: '任务还没完成，先完成后才能' + taskIntent.action }
                } else if (taskIntent.action === '归档') {
                  const changed = ceoRoleChat.setTaskStatus(target.id, '已归档', { assignee: 'secretary' })
                  taskChange = changed && changed.ok
                    ? { ok: true, label: taskIntentLabel(taskIntent), task: changed.task }
                    : { ok: false, message: (changed && changed.message) || '归档失败' }
                } else {
                  try {
                    const feed = writeHistorianFeed({ dataDir, task: target })
                    const changed = ceoRoleChat.setTaskStatus(target.id, '已记忆', { assignee: 'historian' })
                    taskChange = changed && changed.ok
                      ? { ok: true, label: taskIntentLabel(taskIntent) + '（记忆卡：' + feed.file + '）', task: changed.task }
                      : { ok: false, message: '记忆卡写不进去' }
                  } catch (error) {
                    taskChange = { ok: false, message: '存为记忆失败：' + String(error && error.message ? error.message : error) }
                  }
                }
              } else {
                const status = taskIntent.action === '转交秘书' ? '待办' : taskIntent.action
                const changed = ceoRoleChat.setTaskStatus(target.id, status, taskIntent.action === '转交秘书' ? { assignee: 'secretary' } : {})
                taskChange = changed && changed.ok
                  ? { ok: true, label: taskIntentLabel(taskIntent), task: changed.task }
                  : { ok: false, message: (changed && changed.message) || '改任务状态失败' }
                // 接下任务后自动开执行会话：只有用户明确说开任务/开会话才开；模糊任务先问
                if (taskChange.ok && taskIntent.action === '进行中' && !target.sessionId && target.explicitNew === true) {
                  const card = taskFlow.writeHandoff({ task: target })
                  const spawned = await ceoExecutor.execute({ task: target.title, handoffCard: card.ok ? card.path : '' })
                  if (spawned && spawned.ok) {
                    ceoRoleChat.patchTask(target.id, { sessionId: spawned.sessionId, handoffCard: card.ok ? card.path : '' })
                    if (card.ok) taskFlow.writeHandoff({ task: { ...target, sessionId: spawned.sessionId }, sessionId: spawned.sessionId })
                  } else if (typeof ceoRoleChat.patchTask === 'function') {
                    ceoRoleChat.patchTask(target.id, { spawnError: String((spawned && spawned.message) || 'no_session') })
                  }
                  autoSession = spawned && spawned.ok ? spawned : { ok: false, message: (spawned && spawned.message) || '开会话失败' }
                } else if (taskChange.ok && taskIntent.action === '进行中' && !target.sessionId) {
                  noAutoSession = true
                }
              }
            } else if (taskIntent.taskId) {
              taskChange = { ok: false, message: '任务板里没有 ' + taskIntent.taskId }
            }
          }
          // 只走绑定会话（D-01）：失败按 4xx/5xx 回，客户端把 message 直接显示给用户
          const viaSession = await ceoRoleChat.chat(question)
          if (taskChange && taskChange.ok && viaSession && viaSession.ok) {
            viaSession.text = (viaSession.text || '') + String.fromCharCode(10, 10) + '（' + taskChange.label + '：' + taskChange.task.id + ' ' + taskChange.task.title + '）'
            if (autoSession && autoSession.ok) viaSession.text += String.fromCharCode(10) + '（已开执行会话：' + autoSession.sessionTitle + ' ' + autoSession.sessionId + '）'
            if (autoSession && !autoSession.ok) viaSession.text += String.fromCharCode(10) + '（任务已接下，但执行会话没开成：' + autoSession.message + '）'
            if (noAutoSession) viaSession.text += String.fromCharCode(10) + '（已接下；没有自动开新会话：先找旧会话，找不到先问用户是哪个会话、要不要新建）'
          }
          if (taskChange && !taskChange.ok && viaSession) {
            const note = '（' + taskChange.message + '）'
            if (viaSession.ok) viaSession.text = (viaSession.text || '') + String.fromCharCode(10, 10) + note
            else viaSession.message = String(viaSession.message || '') + note
          }
          audit.write({ role: 'ceo', action: 'chat', target: viaSession.ok ? 'session' : 'failed', result: viaSession.ok ? 'ok' : 'failed', reason: String(question).slice(0, 60) })
          sendChat(res, viaSession)
        },
      }),
    )

    // 2026-10-26 新增：问史官（读它自己的言行录；不开史官时明确拒绝）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/historian/ask`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          if (!config.enabled || !config.enabled.historian) {
            return sendJson(res, 200, { ok: false, code: 'historian_disabled', message: '史官现在是关闭的（0.47.0 发布默认开启，是被手动关掉的）。要看记录就把 enabled.historian 打开。' })
          }
          const question = String((body && body.question) || '').slice(0, 500)
          const root = join(dirname(dataDir), '史官', '言行录')
          let text = ''
          try {
            const months = readdirSync(root).sort().slice(-2)
            for (const month of months) {
              for (const file of readdirSync(join(root, month)).sort().slice(-7)) {
                text += readFileSync(join(root, month, file), 'utf8') + '\n'
              }
            }
          } catch {
            text = ''
          }
          if (!text.trim()) return sendJson(res, 200, { ok: true, answer: '史官还没有记录（先跑一次史官）。' })
          sendJson(res, 200, { ok: true, answer: text.slice(-4000), question, note: '这是史官原始记录（按最近 7 天），未经过模型改写' })
        },
      }),
    )

    // 2026-10-26 夜：秘书聊天（陪伴型，固定会话）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/secretary/chat`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const question = String((body && body.question) || '')
          // 2026-10-26：秘书说"记一下"就真的记成待办（这样 CEO/优先级都能接住）
          let addedTodo = null
          const m = question.match(/^(记一下|记下来|帮我记|记成待办|记一条)[:：,，\s]*(.+)$/)
          if (m && m[2] && m[2].trim()) {
            const added = ledger.add({ title: m[2].trim(), source: { kind: 'secretary-chat', at: new Date().toISOString() } })
            if (added && added.ok) addedTodo = added.item
          }
          // 2026-10-26：秘书说"让 CEO 做…/交给 CEO"就真的派活到共享任务板（CEO 能看到并接）
          let assignedTask = null
          const delegate = question.match(/(?:让|叫|请|交给)\s*CEO\s*(?:去|来|帮|做|处理|接手|跑)?\s*[:：,，\s]*(.+)$/)
          if (delegate && delegate[1] && delegate[1].trim()) {
            const assigned = secretaryChat.assignTask({ title: delegate[1].trim(), assignee: 'ceo', by: 'secretary' })
            if (assigned && assigned.ok) assignedTask = assigned.task
          if (assignedTask) {
            const label = question.slice(0, 800)
            try { await ceoRoleChat.notice('用户转交任务 ' + assignedTask.id + '：' + assignedTask.title + '\n原话：' + label + (assignedTask.explicitNew === true ? '\n这是明确要开的新任务：请开任务会话。' : '\n这不是明确要新建：先找旧会话，找不到先问用户是哪个会话、要不要新建，不要直接开会话。')) } catch {}
          }
          }
          // 秘书不能"嘴上说问过 CEO"：说问就必须真转
          let autoHandoff = null
          if (/(问|请|转|交|发|找).{0,4}CEO|请示|让 CEO|CEO 来/.test(question)) {
            const delegated = assignedTask || (() => {
              const made = secretaryChat.assignTask({ title: question.slice(0, 200), assignee: 'ceo', by: 'secretary', facts: '(来自秘书对话)' })
              return made && made.ok ? made.task : null
            })()
            if (delegated) autoHandoff = delegated
          }
          const result = await secretaryChat.chat(question)
          if (autoHandoff && result && result.ok && !assignedTask) {
            result.text = '已经挂到 CEO 名下：' + autoHandoff.id + '（' + autoHandoff.title + '）' + String.fromCharCode(10, 10) + '我没有替 CEO 回答；想看它怎么判，去 CEO 面板看这条任务，或在「dsh小助手 · CEO 对话」里直接问它。'
          }
          if (assignedTask && result && result.ok) result.text = (result.text || '') + '\n\n（已挂到 CEO 名下：' + assignedTask.id + '：' + assignedTask.title + '）'
          if (addedTodo && result && result.ok) result.text = (result.text || '') + '\n\n（已记成待办 ' + addedTodo.id + '：' + addedTodo.title + '）'
          audit.write({ role: 'secretary', action: 'chat', target: result.ok ? 'session' : 'failed', result: result.ok ? 'ok' : 'failed', reason: question.slice(0, 60) })
          sendChat(res, result)
        },
      }),
    )

    // 2026-10-26 夜：史官聊天（必须已有手动开的史官会话，不自动开）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/historian/chat`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const question = String((body && body.question) || '')
          const result = await historianChat.chat(question)
          // 史官要么按史实回答，要么把问题移交 CEO（带事实底稿）
          let historianHandoff = null
          const needsCeo = /谁在说谎|谁对|谁错|该不该|怎么办|怎么处理|为什么|评价|判断|决策|谁先|优先级|要不要|能不能|CEO|转|移交|通知|汇报|催/.test(question)
          if (needsCeo) {
            const facts = result && result.ok ? String(result.text || '').slice(0, 1000) : '（这次没取到史实，见言行录文件）'
            const handed = historianChat.assignTask({ title: question, assignee: 'ceo', by: 'historian', facts })
            if (handed && handed.ok) historianHandoff = handed.task
          }
          if (historianHandoff && result && result.ok) {
            result.text = '（这个问题要判断，超出史官职责 → 已连同史实交给 CEO：' + historianHandoff.id + '）\n\n' + result.text
          }
          audit.write({ role: 'historian', action: 'chat', target: result.ok ? 'session' : 'failed', result: result.ok ? 'ok' : 'failed', reason: question.slice(0, 60) })
          sendChat(res, result)
        },
      }),
    )

    // 2026-10-26 夜：把"你手动开的史官会话"绑给史官聊天（不自动开）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/historian/bind`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          // D-01/A1：绑定即记下会话当前最大 seq；之后聊天只认绑定后新产生的回复
          const result = await historianChat.bind(body && body.sessionId, body && body.title)
          audit.write({ role: 'historian', action: 'bind', target: String((body && body.sessionId) || ''), result: result.ok ? 'ok' : 'failed', reason: result.ok ? 'lastSeq=' + result.lastSeq : result.code })
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26 夜：归档一个会话（走宿主官方 workspaceController.archiveSession）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/session/archive`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const sessionId = String((body && body.sessionId) || '')
          if (!sessionId) return sendJson(res, 200, { ok: false, code: 'empty', message: '给个会话 id' })
          const registry = safeGet(ctx, 'workspaceController') || safeGet(ctx, 'workspaceRegistry')
          if (!registry || typeof registry.archiveSession !== 'function') {
            return sendJson(res, 200, { ok: false, code: 'no_archive', message: '这个环境没有会话归档接口' })
          }
          try {
            await registry.archiveSession({ sessionId })
            audit.write({ role: 'core', action: 'session:archive', target: sessionId, result: 'ok' })
            sendJson(res, 200, { ok: true, sessionId })
          } catch (error) {
            sendJson(res, 200, { ok: false, code: 'archive_failed', message: '归档失败：' + String(error && error.message ? error.message : error) })
          }
        },
      }),
    )

    // 一键把三个角色会话建好并绑定
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/roles/bootstrap`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const result = await bootstrapRoles()
          sendJson(res, 200, result)
        },
      }),
    )

    // 2026-10-26：手动刷新——立刻重算采集/看板/提醒（等同心跳跑一次）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/refresh`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          try {
            await refresh()
            audit.write({ role: 'core', action: 'refresh', target: 'manual', result: 'ok' })
            sendJson(res, 200, { ok: true, at: runtime.computedAt || new Date().toISOString() })
          } catch (error) {
            sendJson(res, 200, { ok: false, code: 'refresh_failed', message: String(error && error.message ? error.message : error) })
          }
        },
      }),
    )

    // 2026-10-26：把史官的问题+史实硬转给 CEO（按钮触发，不靠模型自觉）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/historian/handoff`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const question = String((body && body.question) || '（未说明问题）').slice(0, 500)
          let facts = ''
          try {
            const f = join(dataDir, '史官', '对话', new Date().toISOString().slice(0, 10) + '.md')
            facts = readFileSync(f, 'utf8').slice(-1500)
          } catch {
            facts = ''
          }
          const handed = historianChat.assignTask({ title: question, assignee: 'ceo', by: 'historian', facts })
          if (!handed || !handed.ok) return sendJson(res, 200, handed || { ok: false, code: 'failed', message: '没转成' })
          const notified = await notifyCeoHandoff(handed.task, facts, 'historian')
          audit.write({ role: 'historian', action: 'handoff', target: handed.task.id, result: notified.ok ? 'ok' : 'partial' })
          sendJson(res, 200, { ok: true, taskId: handed.task.id, notified: notified.ok, message: notified.ok ? '' : '任务已挂到 CEO 名下，但消息没送进 CEO 会话：' + notified.message })
        },
      }),
    )

    // 2026-10-26：通用转交给 CEO（秘书/史官/看板按钮都走这里；硬动作）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/handoff`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const fromRole = String((body && body.role) || 'secretary')
          const question = String((body && body.question) || '（未说明问题）').slice(0, 500)
          const chat = fromRole === 'historian' ? historianChat : secretaryChat
          let facts = ''
          try {
            const dir = fromRole === 'historian' ? '史官' : '秘书'
            facts = readFileSync(join(dataDir, dir, '对话', new Date().toISOString().slice(0, 10) + '.md'), 'utf8').slice(-1500)
          } catch {
            facts = ''
          }
          const handed = chat.assignTask({ title: question, assignee: 'ceo', by: fromRole, facts })
          if (!handed || !handed.ok) return sendJson(res, 200, handed || { ok: false, code: 'failed', message: '没转成' })
          const notified = await notifyCeoHandoff(handed.task, facts, fromRole)
          audit.write({ role: fromRole, action: 'handoff', target: handed.task.id, result: notified.ok ? 'ok' : 'partial' })
          sendJson(res, 200, { ok: true, taskId: handed.task.id, from: fromRole, notified: notified.ok, message: notified.ok ? '' : '任务已挂到 CEO 名下，但消息没送进 CEO 会话：' + notified.message })
        },
      }),
    )


    // 2026-10-26：看板 CEO 任务板按钮（接下/完成）
    disposers.push(
      guardedRegister({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/task/status`,
        handler: async (req, res) => {
          if (req.method && String(req.method).toUpperCase() !== 'POST') {
            return sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '这个接口只接受 POST' })
          }
          if (!writeGuard(req, res)) return
          const body = await readJsonBody(req)
          if (body && body.__invalidJson) return sendJson(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' })
          const id = String((body && body.id) || '')
          const status = String((body && body.status) || '')
          const action = String((body && body.action) || '')
          const assignee = String((body && body.assignee) || '').trim()
          if (!id) return sendJson(res, 200, { ok: false, code: 'empty', message: '给任务 id' })
          if (action) {
            const tasks = ceoRoleChat.readTasks()
            const current = tasks.find((task) => task.id === id)
            if (!current) return sendJson(res, 200, { ok: false, code: 'not_found', message: '没找到 ' + id })
            if (current.status !== '完成') {
              return sendJson(res, 200, { ok: false, code: 'not_completed', message: '任务还没完成，先点「完成」，再' + (action === 'archive' ? '归档' : '存为记忆') })
            }
            if (action === 'archive') {
              const archived = ceoRoleChat.setTaskStatus(id, '已归档', { assignee: 'secretary' })
              if (archived && archived.ok) void ceoRoleChat.notice('【系统记录】任务 ' + id + ' 已归档，交给秘书收尾。').catch(() => {})
              audit.write({ role: 'ceo', action: 'task:archive', target: id, result: archived && archived.ok ? 'ok' : 'failed' })
              return sendJson(res, 200, archived || { ok: false, code: 'failed', message: '归档失败' })
            }
            if (action === 'remember') {
              try {
                const feed = writeHistorianFeed({ dataDir, task: current })
                const remembered = ceoRoleChat.setTaskStatus(id, '已记忆', { assignee: 'historian' })
                if (remembered && remembered.ok) void ceoRoleChat.notice('【系统记录】任务 ' + id + ' 已存为记忆，记忆卡：' + feed.file).catch(() => {})
                audit.write({ role: 'ceo', action: 'task:remember', target: id, result: remembered && remembered.ok ? 'ok' : 'failed', reason: feed.file })
                return sendJson(res, 200, remembered ? { ...remembered, memoryPath: feed.file } : { ok: false, code: 'failed', message: '记忆卡写不进去' })
              } catch (error) {
                return sendJson(res, 200, { ok: false, code: 'feed_failed', message: '存为记忆失败：' + String(error && error.message ? error.message : error) })
              }
            }
            return sendJson(res, 400, { ok: false, code: 'unknown_action', message: '不认识的动作：' + action })
          }
          if (!status) return sendJson(res, 200, { ok: false, code: 'empty', message: '给 id 和 status' })
          const changed = ceoRoleChat.setTaskStatus(id, status, assignee ? { assignee } : undefined)
          audit.write({ role: 'ceo', action: 'task:status', target: id + ':' + status + (assignee ? '→' + assignee : ''), result: changed && changed.ok ? 'ok' : 'failed' })
          if (changed && changed.ok) void ceoRoleChat.notice('【系统记录】任务 ' + id + ' 状态改为「' + status + '」。').catch(() => {})
          sendJson(res, 200, changed || { ok: false, code: 'failed', message: '改不了' })
        },
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 清理失败不影响卸载 */
        }
      }
    }
  })

  // 启动先算一次，但**延后 1.2s**：避免和 DSH 启动抢资源（用户反馈重启变慢）
  recompute()
  try {
    const written = writeRepairStation({
      dataDir,
      store,
      config,
      runtime: { version: VERSION, timerOk: Boolean(timerService), collectOk: Boolean(runtime.snapshot && runtime.snapshot.ok), collectError: runtime.collectError || (runtime.snapshot ? '' : '还没采过（启动 1.2 秒后会自动采）'), degraded: runtime.degraded },
    })
    runtime.repairPath = written.ok ? written.path : null
  } catch (error) {
    runtime.repairPath = null
  }
  const firstRefreshTimer = setTimeout(() => {
    refresh()
      .then(() => {
        // 2026-10-26 修 R-04：首次采集完成后重写维修站，别让它永远写"会话采集失败"
        try {
          writeRepairStation({
            dataDir,
            store,
            config,
            runtime: { version: VERSION, timerOk: Boolean(runtime.timerRegistered), collectOk: Boolean(runtime.snapshot && runtime.snapshot.ok), collectError: runtime.collectError || '', degraded: runtime.degraded },
          })
        } catch {
          /* 维修站写不了不影响主功能 */
        }
      })
      .catch((error) => log('initial refresh failed: ' + String(error && error.message ? error.message : error)))
  }, Number(config.startupRefreshMs) || 0)
  if (firstRefreshTimer && typeof firstRefreshTimer.unref === 'function') firstRefreshTimer.unref()
}

/* ── 指令解析与执行（M1：三条固定句式） ────────────────────── */

export function parseCommand(text) {
  if (!text) return { ok: false, code: 'empty', message: '你要我做什么？可以说"确认 T-015 2026-10-26 18:00 紧急 重要"' }

  // 支持带"最"的说法："确认 T-001 明天 18:00 最紧急 最重要"
  // "最"＝在四象限之上再提一级（见 core/priority.js）
  const confirm = text.match(/^确认\s+(T-\d{3,})(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(\d{1,2}:\d{2}))?(?:\s+(最?紧急))?(?:\s+(最?重要))?$/)
  if (confirm) {
    const urgentWord = confirm[4] || ''
    const importantWord = confirm[5] || ''
    return {
      ok: true,
      code: 'confirm',
      message: importantWord.startsWith('最') || urgentWord.startsWith('最')
        ? '收到，这两条都是"最"级，优先级提到最高'
        : '收到',
      payload: {
        id: confirm[1],
        // 2026-10-26 修 R-01：只传用户真的说出来的字段。
        // 以前 due 恒传 null、urgency/importance 恒传 1 → "确认 T-001"（不带日期）
        // 会把已有截止日清空、优先级打回 1，提醒永远不响。
        due: confirm[2] || undefined,
        time: confirm[3] || undefined,
        urgency: urgentWord ? 3 : undefined,
        importance: importantWord ? 3 : undefined,
        mostUrgent: urgentWord ? urgentWord.startsWith('最') : undefined,
        mostImportant: importantWord ? importantWord.startsWith('最') : undefined,
      },
    }
  }

  const drop = text.match(/^划掉\s+(T-\d{3,})$/)
  if (drop) return { ok: true, code: 'drop', message: '收到', payload: { id: drop[1] } }

  const done = text.match(/^(T-\d{3,})\s*做完了$/)
  if (done) return { ok: true, code: 'done', message: '收到', payload: { id: done[1] } }

  return { ok: false, code: 'unparsed', message: '这句我还没学会，先支持：确认 T-x 时间 紧急 重要 / 划掉 T-x / T-x 做完了' }
}

export function applyCommand(ledger, text) {
  const parsed = parseCommand(text)
  if (!parsed.ok) return parsed

  const { id, due, time, urgency, importance, mostUrgent, mostImportant } = parsed.payload
  let result
  if (parsed.code === 'confirm') result = ledger.confirm(id, { due, dueTime: time, urgency, importance, mostUrgent, mostImportant })
  else if (parsed.code === 'drop') result = ledger.drop(id)
  else result = ledger.done(id)

  if (!result.ok) return { ok: false, code: result.code, message: result.message }
  // FIX-04：说清什么时候会提醒（系统只在三个定点提醒，不支持自定义时刻）
  const slotNote = time ? `（只说提醒时段：系统在 08:05 / 12:05 / 18:05 定点提醒，你写的 ${time} 会在之后最近的那个点带上）` : ''
  return { ok: true, code: parsed.code, message: `${result.item.id} 现在是「${result.item.status}」${slotNote}`, item: result.item }
}

/* ── 小工具（全部防御式） ───────────────────────────────────── */

/** 安全取服务：Cordis 里未 inject 的属性访问会抛错，一律用 ctx.get */
function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function safeCall(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function countLive(snapshot) {
  try {
    return (snapshot.sessions || []).filter((session) => session.live).length
  } catch {
    return 0
  }
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"code":"internal_error"}')
    } catch {
      /* 客户端已断开 */
    }
  }
}

/**
 * 角色聊天的统一出口：成功 200；失败按 role-chat 给的 httpStatus（4xx/5xx）回，
 * 客户端拿到 json.message 直接显示——不许把"没答上来"包装成 200 成功。
 */
function sendChat(res, result) {
  if (result && result.ok) return sendJson(res, 200, result)
  const status = result && Number.isInteger(result.httpStatus) ? result.httpStatus : 502
  return sendJson(res, status, result || { ok: false, code: 'chat_failed', message: '聊天没走通' })
}

// 2026-10-26 修 A-06：写接口至少挡住跨源网页与非法提交，不裸奔。
function writeGuard(req, res) {
  const headers = (req && req.headers) || {}
  const origin = headers.origin
  if (origin) {
    try {
      const parsed = new URL(origin)
      const host = headers.host
      if (host && parsed.host !== host) {
        sendJson(res, 403, { ok: false, code: 'cross_origin', message: '拒绝跨源写入（只接受本页发起的请求）' })
        return false
      }
    } catch {
      /* Origin 解析不了就不拦，避免误伤 */
    }
  }
  return true
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      if (raw.length < 64 * 1024) raw += chunk
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})          // 空 body 当空对象（GET 式调用/探测）
      try {
        resolve(JSON.parse(raw))
      } catch {
        // 2026-10-26：坏 JSON 以前被当成空对象，界面上只能说"待办得有个名字"，误导排查。
        // 现在明确标记成非法 JSON，由调用方回 invalid_json。
        resolve({ __invalidJson: true })
      }
    })
    req.on('error', () => resolve({}))
  })
}
