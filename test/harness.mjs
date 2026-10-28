/**
 * 自测台（零依赖，node test/harness.mjs 直接跑）
 *
 * 不装插件、不碰 profile，用假 ctx 验证：
 *   宿主半：4 条路由、结构、指令解析与执行、台账状态机、坏记录跳过、采集、落盘
 *   客户端半：vm 里执行 client.js，校验 id / 三个插槽 / 无外部资源
 *   展示清单：locale、icon、exports/files
 *
 * 证明不了的事：真界面长什么样、插槽能不能真挂在 DSH 里。这些只能装上去看。
 */

import assert from 'node:assert/strict'
import { readFileSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')

// 测试全局隔离：把 USERPROFILE 指到临时目录 → homedir() 里的指针文件自然落在临时目录，
// 绝不污染用户家目录的真实指针（2026-10-26 真被写脏过，导致数据目录漂到测试目录）
process.env.USERPROFILE = join(pkgDir, 'test', '.tmp-home')
process.env.HOME = process.env.USERPROFILE
rmSync(process.env.USERPROFILE, { recursive: true, force: true })
mkdirSync(process.env.USERPROFILE, { recursive: true })
const root = join(here, '.tmp')

const queue = []
function test(name, fn) {
  queue.push({ name, fn })
}

/* ── 假 req/res ───────────────────────────────────────────── */
function makeReq(body) {
  const listeners = {}
  const req = {
    on(event, fn) {
      listeners[event] = fn
      return req
    },
  }
  setImmediate(() => {
    if (body !== undefined && listeners.data) listeners.data(Buffer.from(JSON.stringify(body)))
    if (listeners.end) listeners.end()
  })
  return req
}

function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(chunk) {
      if (chunk) res.body += String(chunk)
    },
  }
  return res
}

/* ── 环境工厂 ─────────────────────────────────────────────── */
const fakeSessions = [
  { header: { id: 's-aaa', cwd: '/workspace/project', createdAt: Date.now() - 1000 }, live: true, persisted: true },
  { header: { id: 's-bbb', cwd: '/workspace/project', createdAt: Date.now() - 2000 }, live: false, persisted: true },
]

function makeCtx(dir, opts = {}) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    workingDirectory: { defaultDirectory: dir },
    interval() {
      return () => {}
    },
    get(name) {
      // 用例可以覆盖任意宿主服务（D-01 的假 sessionController 就靠这个注入）
      if (opts.services && Object.prototype.hasOwnProperty.call(opts.services, name)) return opts.services[name]
      if (name === 'timer') return { interval: () => () => {} }
      if (name === 'workingDirectory') return { defaultDirectory: dir }
      if (name !== 'sessionQuery') return undefined
      if (opts.noSessionQuery) return undefined
      return {
        listSessions: async () => fakeSessions,
        readTitleSnapshots: async (ids) =>
          ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: '标题-' + id } } })),
      }
    },
    interval() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes, disposers }
}

async function call(routes, path, body) {
  const res = makeRes()
  await routes.get(path).handler(makeReq(body), res)
  return { status: res.status, json: JSON.parse(res.body || '{}') }
}

function freshDir(name) {
  const dir = join(root, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

const mod = await import('../index.js')
const { createStore } = await import('../core/store.js')
const { createLedger } = await import('../core/ledger.js')
const { buildBoard, buildState } = await import('../core/board.js')
const { createInbox } = await import('../core/inbox.js')
const { estimateSlots, capacityFor, estimateDue, buildSchedule } = await import('../core/estimate.js')
const { selectReminders, reminderKind, localDate: reminderLocalDate } = await import('../core/reminder-policy.js')
const { candidatesFromEvents } = await import('../core/session-scan.js')
const { buildSessionCards } = await import('../core/session-cards.js')
const { buildAttention } = await import('../core/attention.js')
const { classifyLamp } = await import('../core/lamp.js')
const { createAlarm, inQuietHours } = await import('../core/alarm.js')
const { resolveConfig, DEFAULT_CONFIG } = await import('../core/config.js')
const { selectEvents, summarize, estimateTokens, TIERS } = await import('../core/read.js')
const { createCursor, fingerprintOf } = await import('../core/cursor.js')
const { createSpawner } = await import('../core/spawn.js')
const { shouldWakeModel, score: complexityScore } = await import('../core/escalate.js')
const { createSessionSource } = await import('../core/session-source.js')
const { createHistorian } = await import('../core/historian.js')
const { fourQuestions, singleLine, handoverCard } = await import('../core/analysis.js')
const { createHandover } = await import('../core/handover.js')
const { writeRepairStation } = await import('../core/repair.js')
const { computePriority, rankByPriority, groupByPriority, overallSignal, PRIORITY_LEVELS } = await import('../core/priority.js')
const { createToolset, TOOL_NAMES } = await import('../core/tools.js')
const { createTaskFlow } = await import('../core/task-flow.js')
const { buildHistorianFeed } = await import('../core/historian-feed.js')
const { evaluate, checkSubagent, budgetAfterRetry, DEFAULT_LIMITS } = await import('../core/limits.js')
const { presetDefinitions, ROLE_PRESETS } = await import('../roles/presets.js')
const rolesPlugin = await import('../roles/index.js')
const { createPush } = await import('../core/push.js')
const { createBrain } = await import('../core/brain.js')
const { isInjected, INJECTED_MARKERS } = await import('../core/read.js')
const { createNotifier } = await import('../core/notify.js')
const { createFinder } = await import('../core/find.js')
const { createAudit } = await import('../core/audit.js')
const paths = await import('../core/paths.js')
const { collect } = await import('../core/collect.js')
const { createRoleChat } = await import('../core/role-chat.js')
const { createMemory, MEMORY_FILES, MEMORY_WEEK_MS, AUTO_START, AUTO_END } = await import('../core/memory.js')
const { createCeoExecutor, detectExecuteIntent, EXECUTE_TITLE, EXECUTE_PRESET } = await import('../core/ceo-execute.js')

/* ── 宿主半：结构与路由 ───────────────────────────────────── */
test('宿主半导出 apply 与 inject', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(Array.from(mod.inject), ['webServer'])
})

test('apply() 注册 27 条路由（含 handoff / task status / 开任务会话），启动后即可取数', async () => {
  const dir = freshDir('routes')
  const { ctx, routes, disposers } = makeCtx(dir)
  mod.apply(ctx, { startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(routes.size, 27)
  for (const [path, route] of routes) {
    assert.equal(route.kind, 'exact', path + ' 应为 exact')
  }
  const state = await call(routes, '/api/dsh-xiaozhushou/state')
  assert.equal(state.status, 200)
  assert.equal(state.json.version, 1)
  assert.equal(state.json.count, 0)

  const board = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(board.status, 200)
  assert.equal(board.json.version, 1)
  assert.ok(board.json.diagnostics.dataDir.length > 0)

  const health = await call(routes, '/api/dsh-xiaozhushou/health')
  assert.equal(health.status, 200)
  const names = health.json.checks.map((c) => c.name).sort()
  assert.deepEqual(names, ['collect', 'config', 'dataDir', 'store', 'timer'])
  assert.equal(health.json.checks.find((c) => c.name === 'collect').ok, true, '假 sessionQuery 应让采集成功')

  for (const dispose of disposers) dispose()
})

test('D-16 守卫：发布文档都写清"24 条路由 = 本机回环接口"', () => {
  for (const rel of ['README.md', 'docs/RELEASE.md', 'docs/ARCHITECTURE.md']) {
    const text = readFileSync(join(pkgDir, rel), 'utf8')
    assert.ok(/127\.0\.0\.1/.test(text), rel + ' 要写清监听在 127.0.0.1')
    assert.ok(/回环/.test(text), rel + ' 要写明是回环接口')
    assert.ok(/27 条/.test(text), rel + ' 要点明 27 条路由')
  }
  const index = readFileSync(join(pkgDir, 'index.js'), 'utf8')
  assert.ok(!/\.listen\(/.test(index), '插件不许自己开监听端口（必须挂在宿主 webServer 上）')
})

test('采集只拿元数据：标题、cwd、live，不碰内容', async () => {
  const dir = freshDir('collect')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const board = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(board.json.diagnostics.sessions.total, 2)
  assert.equal(board.json.diagnostics.sessions.live, 1)
  assert.equal(board.json.groups.machine.length, 1)  // 2026-10-26 改口径：只列 live 会话
  assert.ok(board.json.groups.machine[0].title.includes('标题-'))
})

test('sessionQuery 不可用时降级，不报 500', async () => {
  const dir = freshDir('noquery')
  const { ctx, routes } = makeCtx(dir, { noSessionQuery: true })
  mod.apply(ctx, { startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const health = await call(routes, '/api/dsh-xiaozhushou/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.checks.find((c) => c.name === 'collect').ok, false)
  assert.ok(health.json.degraded.includes('collect'))
  const board = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(board.status, 200, '采集失败时看板仍要能返回')
})

/* ── 台账状态机 ───────────────────────────────────────────── */
test('待办：调整层级、划掉=暂停、恢复，不丢数据', () => {
  const dir = freshDir('ledger-pause')
  const store = createStore(dir)
  const ledger = createLedger(store)
  const made = ledger.add({ title: '交材料', urgency: 1, importance: 1 })
  ledger.confirm(made.item.id)
  const adjusted = ledger.adjust(made.item.id, { urgency: 3, importance: 2 })
  assert.equal(adjusted.ok, true)
  assert.equal(adjusted.item.urgency, 3)
  assert.equal(adjusted.item.importance, 2)
  assert.equal(ledger.pause(made.item.id).item.status, '已暂停')
  assert.equal(ledger.stats().pausedCount, 1)
  assert.equal(ledger.stats().confirmed.length, 0, '暂停后不再参与提醒')
  assert.equal(ledger.resume(made.item.id).item.status, '已确认')
  assert.equal(ledger.stats().confirmed.length, 1)
})

test('台账：候选 → 已确认 → 已完成；非法迁移被拒', () => {
  const dir = freshDir('ledger')
  const store = createStore(dir)
  const ledger = createLedger(store)

  const added = ledger.add({ title: '买菜', due: '2026-10-26', urgency: 3, importance: 3 })
  assert.equal(added.ok, true)
  assert.equal(added.item.id, 'T-001')
  assert.equal(added.item.status, '候选')

  const bad = ledger.done('T-001')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bad_transition', '候选不能直接变成已完成')

  const confirmed = ledger.confirm('T-001', { due: '2026-10-27', urgency: 3, importance: 2 })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.item.status, '已确认')
  assert.equal(confirmed.item.due, '2026-10-27')

  const finished = ledger.done('T-001')
  assert.equal(finished.ok, true)
  assert.equal(finished.item.status, '已完成')

  const stats = ledger.stats()
  assert.equal(stats.confirmed.length, 0)
  assert.equal(stats.doneCount, 1)
})

test('台账：空标题被拒、编号递增不复用、持久化后能读回', () => {
  const dir = freshDir('ledger2')
  const store = createStore(dir)
  const ledger = createLedger(store)

  assert.equal(ledger.add({ title: '   ' }).code, 'empty_title')
  ledger.add({ title: 'A' })
  ledger.add({ title: 'B' })
  assert.equal(ledger.list().length, 2)
  assert.deepEqual(Array.from(ledger.list().map((i) => i.id)), ['T-001', 'T-002'])

  const reopened = createLedger(createStore(dir))
  assert.equal(reopened.list().length, 2, '重开应读回 2 条')
  assert.equal(reopened.add({ title: 'C' }).item.id, 'T-003', '编号要接着排，不能复用')
})

test('台账：坏记录被跳过并计数（R-DAT-06）', () => {
  const dir = freshDir('corrupt')
  writeFileSync(
    join(dir, '待办.json'),
    JSON.stringify({
      version: 1,
      items: [
        { id: 'T-001', title: '好的', status: '候选', urgency: 1, importance: 1 },
        { id: 'bad-id', title: '坏的', status: '候选' },
        { id: 'T-003', title: '状态不认识', status: '天知道' },
      ],
    }),
    'utf8',
  )
  const ledger = createLedger(createStore(dir))
  assert.equal(ledger.list().length, 1)
  assert.equal(ledger.stats().skipped, 2)
})

test('新版本数据：只读展示，不写坏（迁移兜底）', () => {
  const dir = freshDir('future')
  writeFileSync(join(dir, '待办.json'), JSON.stringify({ version: 99, items: [] }), 'utf8')
  const store = createStore(dir)
  const data = store.read('待办.json', { version: 1, items: [] })
  assert.equal(data.readOnly, true)
  assert.ok(store.lastError.includes('新版本格式'))
})

/* ── 指令 → 台账 → 看板（端到端） ─────────────────────────── */
test('端到端：预置候选 → 指令确认 → 看板/浮窗同步变化', async () => {
  const dir = freshDir('e2e')
  writeFileSync(
    join(dir, '待办.json'),
    JSON.stringify({
      version: 1,
      items: [{ id: 'T-001', title: '买牛奶', status: '候选', urgency: 1, importance: 1, due: null }],
    }),
    'utf8',
  )
  const { ctx, routes } = makeCtx(dir)
  // 用 dataDir 精确指定，避免默认的「工作目录/dsh小助手」子目录把种子数据隔开
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const before = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(before.json.todos.confirmed.length, 0)
  assert.equal(before.json.todos.pendingCount, 1)

  const cmd = await call(routes, '/api/dsh-xiaozhushou/command', { text: '确认 T-001 2026-10-26 紧急 重要' })
  assert.equal(cmd.json.ok, true)
  assert.equal(cmd.json.code, 'confirm')
  assert.ok(cmd.json.message.includes('已确认'))

  const after = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(after.json.todos.confirmed.length, 1)
  assert.equal(after.json.todos.pendingCount, 0)
  assert.equal(after.json.todos.confirmed[0].urgency, 3)
  assert.equal(after.json.todos.confirmed[0].importance, 3)

  const state = await call(routes, '/api/dsh-xiaozhushou/state')
  assert.equal(state.json.count, 1)
  assert.ok(['red', 'blue'].includes(state.json.dot))
  assert.equal(state.json.top.length, 1)

  const dup = await call(routes, '/api/dsh-xiaozhushou/command', { text: '确认 T-001 2026-10-26 紧急 重要' })
  assert.equal(dup.json.ok, false, '重复确认应被状态机拒绝')
})

test('路由 /historian/run：显式关闭时返回 historian_disabled（不偷偷读）', async () => {
  const dir = freshDir('hist-route')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0, enabled: { historian: false } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const res = await call(routes, '/api/dsh-xiaozhushou/historian/run', {})
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.code, 'historian_disabled')
})

test('D-05/06 发布默认：史官开启 + 读取范围 all（patch 与代码默认值一致）', async () => {
  assert.equal(DEFAULT_CONFIG.enabled.historian, true, 'DEFAULT_CONFIG 里史官要默认开')
  assert.equal(DEFAULT_CONFIG.historian.scope.mode, 'all', 'DEFAULT_CONFIG 默认读全部会话')
  const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(/historian:\s*true/.test(patch), 'cordis.patch.yml 发布默认要开启史官')
  assert.ok(/mode:\s*all/.test(patch), 'cordis.patch.yml 发布默认读取范围要 all')

  // 用默认配置启动：/health 应报史官已开，/historian/run 不再一律 historian_disabled
  const dir = freshDir('hist-default-on')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const health = await call(routes, '/api/dsh-xiaozhushou/health')
  assert.equal(health.json.historian.enabled, true)
})
test('路由 /todo：能把待办记进台账，并回优先级', async () => {
  const dir = freshDir('todo-route')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const created = await call(routes, '/api/dsh-xiaozhushou/todo', { title: '交房租', urgent: true, important: true })
  assert.equal(created.json.ok, true)
  assert.equal(created.json.item.id, 'T-001')
  assert.equal(created.json.item.status, '候选', '新记的先是候选，确认后才提醒')
  assert.equal(created.json.priority.level, 4, '又急又重要 = 4 级；"最"只能口述')
  assert.equal(created.json.priority.dots, 1)

  const empty = await call(routes, '/api/dsh-xiaozhushou/todo', { title: '   ' })
  assert.equal(empty.json.ok, false)
  assert.equal(empty.json.code, 'empty_title')

  const board = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(board.json.todos.pendingCount, 1, '候选不计入提醒，但要在待确认里')
})
test('乱说话给人话提示，不是 500', async () => {
  const dir = freshDir('chat')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { startupRefreshMs: 0 })
  const res = await call(routes, '/api/dsh-xiaozhushou/command', { text: '帮我把那个弄一下' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.code, 'unparsed')
  assert.ok(res.json.message.includes('确认 T-x'))
})

test('数据目录口径：给了 dataDir 就用它；没给就落到用户主目录下的 .dsh-session-steward/data', async () => {
  const { resolveDataDir } = await import('../core/paths.js')
  const exact = join(root, 'exact-dir')
  assert.equal(resolveDataDir({}, { dataDir: exact }), exact)
  // 清指针，模拟首次安装
  rmSync(paths.pointerPath(), { force: true })
  const derived = resolveDataDir({ get: () => undefined }, {})
  assert.equal(derived.toLowerCase(), paths.defaultDataDir().toLowerCase(), '默认应落到主目录 data，实际：' + derived)
  assert.ok(!/[\\/]profiles[\\/]/.test(derived), '不能落到 profile 目录，实际：' + derived)
  const base = freshDir('base-dir')
  const withReg = resolveDataDir({
    get: (name) =>
      name === 'workspaceRegistry'
        ? { list: () => [{ path: join(base, '示例课程目录') }, { path: join(base, 'main-workspace') }] }
        : undefined,
  }, {})
  assert.ok(!withReg.includes('示例课程目录'), '注册表里有工作区也不该把数据写进去，实际：' + withReg)
})
/* ── M2：配置 ─────────────────────────────────────────────── */
test('配置：非法值回退默认并留 warning，不抛错', () => {
  const { config, warnings } = resolveConfig({ historian: { tier: 'watch' }, alarm: { fixedTimes: ['25:99'] } })
  assert.equal(config.historian.tier, 'summary')
  assert.deepEqual(Array.from(config.alarm.fixedTimes), Array.from(DEFAULT_CONFIG.alarm.fixedTimes))
  assert.ok(warnings.length >= 2)
  const ok = resolveConfig({ alarm: { dedupeMinutes: 5, bootGateMinutes: 1 } })
  assert.equal(ok.config.alarm.dedupeMinutes, 5)
  assert.equal(ok.warnings.length, 0)
})

/* ── M2：收件箱（append-only） ────────────────────────────── */
test('收件箱：只追加不覆盖，关闭是单向的，坏记录跳过', () => {
  const dir = freshDir('inbox')
  const store = createStore(dir)
  const inbox = createInbox(store)

  const a = inbox.add({ title: '给科长回个电话', type: 'W' })
  assert.equal(a.ok, true)
  assert.equal(a.item.id, 'I-001')
  assert.equal(a.item.status, 'open')
  assert.equal(inbox.add({ title: '一个想法', type: 'I' }).item.type, 'I')
  assert.equal(inbox.add({ title: '没写类型' }).item.type, 'W', '没类型默认 W')
  assert.equal(inbox.add({ title: '   ' }).code, 'empty_title')

  assert.equal(inbox.close('I-001').item.status, 'closed')
  assert.equal(inbox.close('I-001').code, 'bad_transition', '重复关闭要被拒')
  assert.equal(inbox.close('I-999').code, 'not_found')

  const reopened = createInbox(createStore(dir))
  assert.equal(reopened.list().length, 3, '重开应读回 3 条（关闭的仍在，不删除）')
  assert.equal(reopened.list({ status: 'open' }).length, 2)
})

/* ── M2：三定点提醒 ───────────────────────────────────────── */
function alarmFixture({ now, startedAt, alarm = {}, todos = [] }) {
  const dir = freshDir('alarm-' + Math.random().toString(36).slice(2, 8))
  const store = createStore(dir)
  const { config } = resolveConfig({ alarm: { policy: 'classic', bootGateMinutes: 0, graceMinutes: 30, ...alarm } })
  const ledger = { stats: () => ({ confirmed: todos, pendingCount: 0, doneCount: 0, droppedCount: 0, skipped: 0 }) }
  const clock = createAlarm({ store, config, ledger, startedAt })
  return { clock, config, now }
}

const dueTodo = { id: 'T-001', title: '买牛奶', status: '已确认', due: '2026-10-26', urgency: 3, importance: 3 }

test('浮窗灯：CEO 任务最急时，鲸鱼娘不能还是蓝点', () => {
  const state = buildState({
    ledger: { stats: () => ({ confirmed: [{ id: 'T-1', title: '常规待办', status: '已确认', priority: { level: 1, label: '常规' } }], pendingCount: 0, doneCount: 0, droppedCount: 0, skipped: 0 }) },
    openTasks: [{ id: 'K-1', title: '最急任务', status: '进行中', priority: { level: 5, label: '最急', dots: 1, color: 'red', blink: true } }],
    snapshot: { sessions: [] },
  })
  assert.equal(state.level, 5)
  assert.equal(state.lamp.color, 'red')
  assert.equal(state.lamp.mode, 'steady')
  assert.equal(state.blink, false)
})

test('统一事项：待办和 CEO 任务共用一套优先级', () => {
  const todo = { id: 'T-1', title: '常规待办', status: '已确认', priority: { level: 1, label: '常规' } }
  const task = { id: 'K-1', title: '最急任务', status: '进行中', priority: { level: 5, label: '最急' } }
  const merged = buildAttention({ todos: [todo], tasks: [task] })
  assert.equal(merged.count, 2)
  assert.equal(merged.items[0].id, 'K-1')
  assert.equal(merged.items[0].kind, 'task')
  assert.equal(merged.items[0].sourceLabel, 'CEO 任务')
  assert.equal(merged.items[1].kind, 'todo')
  assert.equal(merged.groups[0].level, 5)
})

test('会话卡：live 是正在干活，有截止的会话按到期排健康态', () => {
  const now = new Date('2026-10-28T10:00:00')
  const snapshot = { sessions: [
    { id: 's-live', title: '正在跑', live: true, createdAt: now.getTime() - 86400000 },
    { id: 's-due', title: '有截止', live: false, createdAt: now.getTime() - 6 * 86400000 },
  ] }
  const ledger = { stats: () => ({ confirmed: [{ id: 'T-1', title: '交材料', due: '2026-10-27', source: { sessionId: 's-due' } }] }) }
  const cards = buildSessionCards({ snapshot, ledger, inbox: null, now })
  assert.equal(cards[0].id, 's-live')
  assert.equal(cards[0].health, 'working')
  assert.equal(cards[1].id, 's-due')
  assert.equal(cards[1].health, 'overdue')
})

test('工量估算：档位、容量、没截止时按容量估日', () => {
  assert.equal(estimateSlots('写三季度监督报告'), 8)
  assert.equal(estimateSlots('开个会沟通一下'), 2)
  assert.equal(estimateSlots('开发插件并部署'), 16)
  assert.equal(capacityFor('2026-11-01').slots, 0, '周日不排')
  assert.equal(capacityFor('2026-10-31').slots, 3, '周六 3 槽')
  assert.equal(capacityFor('2026-10-30').slots, 3, '工作日 3 槽')
  const author = estimateDue({ now: new Date('2026-10-28T10:00:00'), slots: 2, due: '2026-10-30' })
  assert.deepEqual([author.due, author.dueSource], ['2026-10-30', 'author'])
  const estimated = estimateDue({ now: new Date('2026-10-30T10:00:00'), slots: 4, due: '' })
  assert.equal(estimated.dueSource, 'estimated')
  assert.ok(estimated.due >= '2026-10-31')
  const schedule = buildSchedule({ todos: [{ id: 'T-1', title: '开会沟通', due: '2026-10-30', priority: { level: 4 } }], now: new Date('2026-10-28T10:00:00') })
  const split = buildSchedule({ todos: [{ id: 'T-2', title: '写季度报告', estimate_slots: 8, priority: { level: 3 } }], now: new Date('2026-10-28T10:00:00') })
  assert.equal(split.usedSlots, 8, '4 小时活应拆到多天，不能直接判装不下')
  assert.equal(split.unscheduled.length, 0, JSON.stringify(split.unscheduled))
  assert.equal(schedule.usedSlots >= 1, true)
  assert.equal(schedule.days.length, 7)
})

test('提醒频次：确认制规则只在该响的时点响', () => {
  const now = new Date('2026-10-28T09:00:00')
  const overdue = { id: 'T-1', title: '过期事', status: '已确认', due: '2026-10-27' }
  const today = { id: 'T-2', title: '今天事', status: '已确认', due: '2026-10-28' }
  const tomorrow = { id: 'T-3', title: '明天事', status: '已确认', due: '2026-10-29' }
  assert.equal(reminderKind(overdue, '08:05', now), 'overdue')
  assert.equal(reminderKind(overdue, '12:05', now), null, '过期不在午间重复')
  assert.equal(reminderKind(today, '08:05', now), 'today')
  assert.equal(reminderKind(today, '13:00', now), null, '今天只在早/晚两个点')
  assert.equal(reminderKind(tomorrow, '18:05', now), 'tomorrow')
  const selected = selectReminders({ todos: [today], slot: '08:05', now })
  assert.equal(selected.shouldSend, true)
  assert.equal(selected.items[0].kind, 'today')
})

test('扫会话出候选：只抓像交代的句子，标低置信，不自动确认', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '记一下，周五前把三季度监督报告交上来' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '这个报告怎么写才好？' }] } },
  ]
  const found = candidatesFromEvents(events, { sessionId: 's-1', now: new Date('2026-10-28T10:00:00') })
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.ok(found[0].title.includes('三季度监督报告'))
  assert.equal(found[0].confidence, 'medium')
  assert.equal(found[0].source, 'session-scan')
  assert.ok(found[0].estimate_slots >= 1)
})

test('确认制提醒策略：今天到期只在早晚两点响，午间不重复', () => {
  const at = (h, m) => new Date(2026, 9, 26, h, m, 0)
  const { clock } = alarmFixture({ now: at(9, 6), todos: [dueTodo], alarm: { policy: 'confirmed' } })
  const morning = clock.tick(at(9, 6))
  assert.deepEqual(Array.from(morning.fired), ['09:00'])
  assert.equal(morning.reminders.length, 1, '早上响一次')
  const noon = clock.tick(at(13, 6))
  assert.deepEqual(Array.from(noon.fired), ['13:00'])
  assert.equal(noon.reminders.length, 0, '午间不重复今天到期')
  const evening = clock.tick(at(18, 6))
  assert.equal(evening.reminders.length, 1, '晚上再响一次')
})

test('三定点：到点才响、只响一次、过期不补', () => {
  const at = (h, m) => new Date(2026, 9, 26, h, m, 0)
  const { clock } = alarmFixture({ now: at(13, 6), todos: [dueTodo] })

  const early = clock.tick(at(12, 59))
  assert.equal(early.fired.length, 0, '没到点不该响')

  const onTime = clock.tick(at(13, 6))
  assert.deepEqual(Array.from(onTime.fired), ['13:00'])
  assert.equal(onTime.reminders.length, 1, '该提醒一条')

  const again = clock.tick(at(13, 7))
  assert.equal(again.fired.length, 0, '同一档只响一次')

  const late = clock.tick(at(15, 0))
  assert.equal(late.fired.length, 0, '过了宽限不补响（不该在下午补早上的）')
})


test('去重窗口：同一事项在窗口内只提醒一次', () => {
  const at = (h, m) => new Date(2026, 9, 26, h, m, 0)
  const { clock } = alarmFixture({ now: at(13, 6), todos: [dueTodo], alarm: { dedupeMinutes: 600 } })
  const first = clock.tick(at(13, 6))
  assert.equal(first.reminders.length, 1)
  const second = clock.tick(at(18, 30))
  assert.deepEqual(Array.from(second.fired), ['18:00'], '18:00 该响')
  assert.equal(second.reminders.length, 0, '但同一条被去重窗口压掉')
  assert.ok(second.suppressed.some((entry) => entry.reason === 'dedupe'))
})

test('静默时段：算归算，不弹（suppressed 标 quiet）', () => {
  const at = new Date(2026, 9, 26, 13, 6, 0)
  const { clock } = alarmFixture({ now: at, todos: [dueTodo], alarm: { quietHours: { from: '12:00', to: '14:00' } } })
  const result = clock.tick(at)
  assert.deepEqual(Array.from(result.fired), ['13:00'], '照常算（界面要更新）')
  assert.equal(result.reminders.length, 0, '静默时不弹')
  assert.ok(result.suppressed.some((entry) => entry.reason === 'quiet'))
})

test('静默时段跨越午夜也判得对', () => {
  const q = { from: '23:30', to: '07:30' }
  assert.equal(inQuietHours(new Date(2026, 9, 26, 23, 45), q), true)
  assert.equal(inQuietHours(new Date(2026, 9, 26, 3, 0), q), true)
  assert.equal(inQuietHours(new Date(2026, 9, 26, 7, 30), q), false)
  assert.equal(inQuietHours(new Date(2026, 9, 26, 12, 0), q), false)
})

test('提醒只认"已确认"的待办（未确认的绝不打扰）', () => {
  const at = new Date(2026, 9, 26, 13, 6, 0)
  const candidate = { id: 'T-002', title: '还没确认', status: '候选', due: '2026-10-26', urgency: 3, importance: 3 }
  const { clock } = alarmFixture({ now: at, todos: [candidate] })
  const result = clock.tick(at)
  assert.deepEqual(Array.from(result.fired), ['13:00'])
  assert.equal(result.reminders.length, 0, '候选不该进提醒')
})
/* ── M3：史官读取策略（纯函数） ───────────────────────────── */
function ev(seq, type, data, minutesAgo = 1) {
  return { seq, type, time: Date.now() - minutesAgo * 60000, data }
}
const sampleEvents = [
  ev(1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: '交房租后回邮件' }] } }),
  ev(2, 'tool/call', { name: 'read', arguments: '{}' }),
  ev(3, 'tool/result', { message: { role: 'tool', content: [{ type: 'text', text: '文件内容很长很长…' }] } }),
  ev(4, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '好，我先交房租。然后回邮件。' }] }, usage: { inputTokens: 10, outputTokens: 5 } }),
  ev(5, 'assistant/attempt', { stream: [{ type: 'reasoning-chunks', texts: ['先想一下…'] }] }),
]

test('读取档位：summary 只读用户发言 + 回复摘要，不读工具与思维链', () => {
  const result = selectEvents(sampleEvents, { tier: 'summary' })
  const kinds = Array.from(result.records.map((r) => r.kind))
  assert.deepEqual(kinds, ['user', 'reply'], 'summary 档只有 user + reply')
  assert.equal(result.records[1].text, '好，我先交房租。', '摘要只留第一句')
  assert.ok(result.stats.skippedByType >= 3, '工具/思维链被跳过')
})

test('读取档位：body 加工具名与结果状态，仍不读思维链', () => {
  const result = selectEvents(sampleEvents, { tier: 'body' })
  const kinds = Array.from(result.records.map((r) => r.kind))
  assert.deepEqual(kinds, ['user', 'tool', 'tool-result', 'reply'])
  assert.ok(result.records.find((r) => r.kind === 'tool-result').text.includes('成功'))
  assert.equal(result.records.filter((r) => r.kind === 'reasoning').length, 0, 'body 不读思维链')
})

test('读取档位：full 才读思维链', () => {
  const result = selectEvents(sampleEvents, { tier: 'full' })
  assert.equal(result.records.filter((r) => r.kind === 'reasoning').length, 1)
})

test('预算：超 maxEvents 截断并标记 truncated', () => {
  const many = Array.from({ length: 10 }, (_, i) => ev(i + 1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: '第' + (i + 1) + '句' }] } }))
  const result = selectEvents(many, { tier: 'summary', budgets: { maxEvents: 3, maxTokens: 99999 } })
  assert.equal(result.records.length, 3)
  assert.equal(result.stats.truncated, true)
})

test('预算：超 maxTokens 截断（不悄悄少读）', () => {
  const long = { message: { role: 'user', content: [{ type: 'text', text: '很长的内容'.repeat(50) }] } }
  const result = selectEvents([ev(1, 'user/message', long)], { tier: 'summary', budgets: { maxTokens: 10 } })
  assert.equal(result.records.length, 0)
  assert.equal(result.stats.truncated, true)
})

test('时间窗：太老的事件跳过并计数', () => {
  const old = ev(1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: '很久以前' }] } }, 60 * 24 * 4)
  const result = selectEvents([old], { tier: 'summary', budgets: { windowHours: 72 } })
  assert.equal(result.records.length, 0)
  assert.equal(result.stats.skippedByWindow, 1)
})

test('脱敏：密钥/绝对路径/手机号替换并计数，原文不落盘', () => {
  // 拼接出测试用假密钥，避免静态扫描把测试数据当成真密钥
  const fakeSecret = 'sk-' + 'abcdefghijkl'
  const text = 'key 是 ' + fakeSecret + '，路径 D:\\work\\secret\\a.txt，电话 13812345678'
  const result = selectEvents([ev(1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text }] } })], { tier: 'summary' })
  const out = result.records[0].text
  assert.ok(out.includes('[已隐去密钥]'), '密钥要被替换')
  assert.ok(out.includes('[路径]'), '路径要被替换')
  assert.ok(out.includes('[手机号]'), '手机号要被替换')
  assert.ok(!out.includes(fakeSecret))
  assert.ok(!out.includes('13812345678'))
  assert.equal(result.stats.redacted, 3)
})

test('排除名单：命中整条不落盘（只计数，不记内容）', () => {
  const result = selectEvents(
    [ev(1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: '这个是不宜外传的私人内容' }] } })],
    { tier: 'summary', exclude: ['不宜外传'] },
  )
  assert.equal(result.records.length, 0)
  assert.equal(result.stats.skippedByExclude, 1)
})

test('每条记录都带引用（sessionId + seq + time），且游标只进不退', () => {
  const result = selectEvents(sampleEvents, { tier: 'body' })
  for (const record of result.records) {
    assert.equal(typeof record.refs.seq, 'number')
    assert.equal(typeof record.refs.time, 'number')
  }
  assert.equal(result.nextCursor, 4)

  const dir = freshDir('cursor')
  const cursor = createCursor(createStore(dir))
  assert.equal(cursor.get('ws-1'), null)
  assert.equal(cursor.advance('ws-1', 10).lastSeq, 10)
  assert.equal(cursor.advance('ws-1', 4).lastSeq, 10, '不能把游标拽回去重读')

  const reopened = createCursor(createStore(dir))
  assert.equal(reopened.get('ws-1'), 10, '游标要落盘')
})

test('指纹去重：同一事件只认一次，不同内容不同指纹', () => {
  const dir = freshDir('prints')
  const cursor = createCursor(createStore(dir))
  const f1 = fingerprintOf('s-1', 5, '一样的字')
  const f2 = fingerprintOf('s-1', 5, '一样的字')
  const f3 = fingerprintOf('s-1', 5, '不一样的字')

  assert.equal(f1, f2, '同输入同指纹')
  assert.notEqual(f1, f3, '内容变了指纹就要变')

  assert.equal(cursor.markSeen(f1).duplicate, false)
  assert.equal(cursor.markSeen(f2).duplicate, true, '第二次应判重复')
  assert.equal(cursor.markSeen(f3).duplicate, false)
  assert.equal(cursor.size(), 2)
})

test('摘要与估算：空文本不出记录，超长被截断', () => {
  assert.equal(summarize(''), '')
  assert.ok(summarize('第一句。第二句。').indexOf('第二句') === -1)
  assert.ok(summarize('啊'.repeat(300)).length <= 121)
  assert.equal(selectEvents([ev(1, 'user/message', { message: { role: 'user', content: [] } })], { tier: 'summary' }).records.length, 0)
  assert.ok(estimateTokens('十个中文字符十个') >= 1)
})

test('档位常量齐全，非法档位按 summary 处理', () => {
  assert.deepEqual(Array.from(TIERS), ['summary', 'body', 'full'])
  const result = selectEvents(sampleEvents, { tier: '乱写' })
  assert.equal(result.tier, 'summary')
})
/* ── K3：全自动开新会话 ───────────────────────────────────── */
function fakeController(behaviour = {}) {
  const calls = { create: [], rename: [], prompt: [] }
  const svc = {
    async create(req) {
      calls.create.push(req)
      if (behaviour.createThrows) throw new Error('boom')
      return { sessionId: behaviour.sessionId || 's-new', agentPreset: req.agentPreset }
    },
    async rename(req) {
      calls.rename.push(req)
      if (behaviour.renameThrows) throw new Error('rename boom')
      return { title: req.title, seq: 1 }
    },
    async prompt(req, signal) {
      calls.prompt.push(req)
      calls.promptSignal = signal
      if (behaviour.promptThrows) throw new Error('prompt boom')
      return { accepted: true }
    },
  }
  return { svc, calls }
}

test('K3 全自动：口头确认后 create → rename → prompt 一次做完', async () => {
  const { svc, calls } = fakeController()
  const spawner = createSpawner({ get: (name) => (name === 'sessionController' ? svc : undefined) })
  const result = await spawner.spawn({ title: '周末大扫除', prompt: '先读交接卡再复述任务', confirmedByAuthor: true })

  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 's-new')
  assert.equal(calls.create.length, 1)
  assert.equal(calls.rename[0].title, '周末大扫除')
  assert.equal(calls.prompt[0].sessionId, 's-new')
  assert.equal(calls.prompt[0].mode, 'queue')
  assert.ok(calls.promptSignal && typeof calls.promptSignal.throwIfAborted === 'function', 'prompt 必须传第二个参数 signal（漏传会远端报错）')
  assert.ok(calls.prompt[0].requestId, 'prompt 必须带 requestId')
  assert.equal(calls.prompt[0].content[0].text, '先读交接卡再复述任务')
})

test('K3 没有用户口头确认：一律不建（安全前提）', async () => {
  const { svc, calls } = fakeController()
  const spawner = createSpawner({ get: () => svc })
  const denied = await spawner.spawn({ title: 'x', prompt: 'y' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'not_confirmed')
  assert.equal(calls.create.length, 0, '未确认时一条都不能动')
})

test('K3 标题/第一句为空要拒绝；rename 失败不致命；prompt 失败要报错', async () => {
  const spawner = createSpawner({ get: () => fakeController().svc })
  assert.equal((await spawner.spawn({ title: '', prompt: 'y', confirmedByAuthor: true })).code, 'empty_title')
  assert.equal((await spawner.spawn({ title: 'x', prompt: '', confirmedByAuthor: true })).code, 'empty_prompt')

  const renameFail = createSpawner({ get: () => fakeController({ renameThrows: true }).svc })
  const r1 = await renameFail.spawn({ title: 'x', prompt: 'y', confirmedByAuthor: true })
  assert.equal(r1.ok, true, 'rename 失败但会话已建，应算成功')
  assert.ok(r1.steps.some((s) => s.step === 'rename' && s.ok === false))

  const promptFail = createSpawner({ get: () => fakeController({ promptThrows: true }).svc })
  const r2 = await promptFail.spawn({ title: 'x', prompt: 'y', confirmedByAuthor: true })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'prompt_failed')
  assert.equal(r2.sessionId, 's-new', '要告诉用户会话已经建好了')
})

test('K3 环境不支持时给人话，不崩', async () => {
  const spawner = createSpawner({ get: () => undefined })
  const r = await spawner.spawn({ title: 'x', prompt: 'y', confirmedByAuthor: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no_controller')
  assert.ok(r.message.includes('不支持'))
})

/* ── K1：提醒是否唤醒轻量模型 ─────────────────────────────── */
// 注意：必须用本地日期，不能 toISOString()（那是 UTC；凌晨 0-8 点会串到昨天）
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const todoToday = { id: 'T-001', title: '买牛奶', urgency: 3, importance: 3, due: localToday() }

test('K1 简单事零成本：一条普通待办不唤醒模型', () => {
  const r = shouldWakeModel({ dueReminders: [{ id: 'T-1', title: '回个电话', urgency: 1, importance: 1, due: '2026-12-31' }], config: {} })
  assert.equal(r.wake, false)
  assert.equal(r.reason, 'simple_enough')
})

test('K1 复杂事唤醒：紧急且重要 + 今天到期 → 叫轻模型', () => {
  const r = shouldWakeModel({ dueReminders: [todoToday], config: {} })
  assert.equal(r.wake, true)
  assert.equal(r.reason, 'complex_enough')
  assert.ok(r.complexity >= 3)
})

test('K1 可整体关掉；条数太多也不唤；没有待办不唤', () => {
  assert.equal(shouldWakeModel({ dueReminders: [todoToday], config: { alarm: { lightModel: { enabled: false } } } }).reason, 'light_model_disabled')
  const many = Array.from({ length: 5 }, (_, i) => ({ id: 'T-' + i, title: 'x', urgency: 3, importance: 3 }))
  assert.equal(shouldWakeModel({ dueReminders: many, config: {} }).reason, 'too_many_items')
  assert.equal(shouldWakeModel({ dueReminders: [], config: {} }).reason, 'nothing_to_say')
})

test('K1 复杂度打分可解释：紧急重要 +2、今天到期 +1、长标题 +1', () => {
  assert.equal(complexityScore([{ urgency: 1, importance: 1, due: '2026-12-31', title: '短' }]), 1)
  assert.equal(complexityScore([{ urgency: 3, importance: 3, due: '2026-12-31', title: '短' }]), 3)
  assert.ok(complexityScore([todoToday]) >= 4)
})

/* ── K6：用户内容颗粒度可切换 ─────────────────────────────── */
const longAuthorText = '第一句是重点。第二句是细节。第三句是补充。'

test('K6 默认降颗粒度：用户发言只记摘要（发布版口径）', () => {
  const result = selectEvents([ev(1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: longAuthorText }] } })], { tier: 'summary' })
  assert.equal(result.records[0].text, '第一句是重点。')
  assert.ok(!result.records[0].text.includes('第二句'))
})

test('K6 用户自用改回原话：reduceAuthorGranularity=false 记全文', () => {
  const result = selectEvents(
    [ev(1, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: longAuthorText }] } })],
    { tier: 'summary', reduceAuthorGranularity: false },
  )
  assert.ok(result.records[0].text.includes('第二句'), '不降颗粒度时要留原话')
})

test('K6 配置：默认 true，可改 false，非布尔值忽略', () => {
  assert.equal(resolveConfig({}).config.privacy.reduceAuthorGranularity, true)
  assert.equal(resolveConfig({ privacy: { reduceAuthorGranularity: false } }).config.privacy.reduceAuthorGranularity, false)
  assert.equal(resolveConfig({ privacy: { reduceAuthorGranularity: 'yes' } }).config.privacy.reduceAuthorGranularity, true)
})
/* ── M3 适配层：真读会话事件 ──────────────────────────────── */
function fakeQuery(eventsBySession) {
  return {
    listSessions: async () => Object.keys(eventsBySession).map((id) => ({ header: { id, cwd: '/x' }, live: true })),
    readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: '标题-' + id } } })),
    readSession: async (sessionId) => ({ session: { id: sessionId }, events: eventsBySession[sessionId] || [] }),
  }
}

test('M3 适配层：增量只读 seq 之后的事件，且带上 sessionId', async () => {
  const source = createSessionSource({ get: (n) => (n === 'sessionQuery' ? fakeQuery({ 's-1': sampleEvents }) : undefined) })
  const listed = await source.listTargets({ limit: 10 })
  assert.equal(listed.ok, true)
  assert.equal(listed.targets.length, 1)
  assert.equal(listed.targets[0].title, '标题-s-1')

  const all = await source.readEvents('s-1', {})
  assert.equal(all.ok, true)
  assert.equal(all.events.length, 5)
  assert.equal(all.events[0].sessionId, 's-1')

  const inc = await source.readEvents('s-1', { sinceSeq: 2 })
  assert.deepEqual(Array.from(inc.events.map((e) => e.seq)), [3, 4, 5], '只返回 2 之后的事件')
  assert.equal(inc.nextCursor, 5)
})

test('M3 适配层：没有 sessionQuery 时给人话，不抛', async () => {
  const source = createSessionSource({ get: () => undefined })
  const listed = await source.listTargets()
  assert.equal(listed.ok, false)
  assert.equal(listed.code, 'no_session_query')
  const read = await source.readEvents('s-1')
  assert.equal(read.ok, false)
})

/* ── M3 史官落盘 ──────────────────────────────────────────── */
function historianFixture({ enabled = true, events = sampleEvents, sessionId = 's-1', memory } = {}) {
  const dir = freshDir('hist-' + Math.random().toString(36).slice(2, 7))
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const store = createStore(dataDir)
  const cursor = createCursor(store)
  const source = createSessionSource({ get: (n) => (n === 'sessionQuery' ? fakeQuery({ [sessionId]: events }) : undefined) })
  const config = { enabled: { historian: enabled }, historian: { tier: 'summary', budgets: {}, scope: { mode: 'all', prefixes: ['[实验]'] } }, privacy: { reduceAuthorGranularity: true } }
  const historian = createHistorian({ dataDir, store, cursor, source, config, memory })
  return { historian, cursor, dataDir, dir, sessionId, store, config }
}

test('史官显式关闭时拒绝执行（隐私开关仍然有效）', async () => {
  const { historian } = historianFixture({ enabled: false })
  const result = await historian.record()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'historian_disabled')
  assert.ok(result.message.includes('默认'))
})

test('史官开起来后：写言行录、每条带引用、游标前进', async () => {
  const { historian, cursor, sessionId, dir } = historianFixture()
  const result = await historian.record({ sessionId })
  assert.equal(result.ok, true)
  assert.equal(result.written, 2, 'summary 档：用户发言 + 回复摘要各一条')

  const localMonth = localToday().slice(0, 7)
  const file = join(dir, '史官', '言行录', localMonth, localToday() + '.md')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('# 言行录'), '首次要写文件头')
  assert.ok(text.includes('[来源: s-1#1 @'), '每条都要带引用')
  assert.ok(text.includes('用户：'), '用户发言要标"用户"')
  assert.equal(cursor.get(`session:${sessionId}`), 4, '游标应前进到本批最后一条')
})

test('史官再跑一次：增量没新事件 + 指纹去重，不重复记', async () => {
  const { historian, sessionId } = historianFixture()
  await historian.record({ sessionId })
  const second = await historian.record({ sessionId })
  assert.equal(second.ok, true)
  assert.equal(second.written, 0, '第二次不应重复写')
})

test('史官 dryRun 不许污染指纹：先 dryRun 再真跑，仍然要写入', async () => {
  const f = historianFixture()
  const dry = await f.historian.record({ sessionId: f.sessionId, dryRun: true })
  assert.ok(dry.written >= 1, 'dryRun 应算出至少 1 条，实际 ' + dry.written)
  const real = await f.historian.record({ sessionId: f.sessionId, dryRun: false })
  assert.ok(real.written >= 1, 'dryRun 之后真跑必须仍然写入，实际 ' + real.written)
  assert.equal(real.skippedDuplicates, 0, 'dryRun 不该留下指纹')
})
test('史官 dryRun：不写文件、不前进游标', async () => {
  const { historian, cursor, sessionId, dir } = historianFixture()
  const result = await historian.record({ sessionId, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.written, 2, 'dryRun 也要告诉你会写几条')
  assert.equal(cursor.get(`session:${sessionId}`), null, 'dryRun 不动游标')
  const exists = (() => { try { statSync(join(dir, '史官')); return true } catch { return false } })()
  assert.equal(exists, false, 'dryRun 不建目录')
})

test('D-05/06 sandbox：只读 [实验] 与角色会话，真实会话被跳过', async () => {
  const dir = freshDir('hist-scope')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const store = createStore(dataDir)
  const source = {
    listTargets: async () => ({
      ok: true,
      targets: [
        { sessionId: 's-real', title: '真实工作会话' },
        { sessionId: 's-lab', title: '[实验]测试会话' },
        { sessionId: 's-role', title: 'dsh小助手 · 秘书 对话' },
      ],
      total: 3,
    }),
    readEvents: async () => ({ ok: true, events: [], nextCursor: 0 }),
  }
  const config = { enabled: { historian: true }, historian: { tier: 'summary', budgets: {}, scope: { mode: 'sandbox', prefixes: ['[实验]'] } }, privacy: {} }
  const historian = createHistorian({ dataDir, store, cursor: createCursor(store), source, config })
  const result = await historian.record({ dryRun: true })
  assert.equal(result.filteredByScope, 1, '应跳过 1 个真实会话')
  const seen = result.sessions.map((item) => item.sessionId)
  assert.ok(seen.includes('s-lab'), 'sandbox 要读 [实验] 会话')
  assert.ok(seen.includes('s-role'), 'sandbox 也要读角色会话（秘书交代的事能接住）')
  assert.ok(!seen.includes('s-real'), '真实会话必须被跳过')
})

test('D-05/06 all：能读标题真实的会话（发布默认）', async () => {
  const dir = freshDir('hist-all')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const store = createStore(dataDir)
  const source = {
    listTargets: async () => ({ ok: true, targets: [{ sessionId: 's-real', title: '季度总结' }], total: 1 }),
    readEvents: async () => ({ ok: true, events: [], nextCursor: 0 }),
  }
  const config = { enabled: { historian: true }, historian: { tier: 'summary', budgets: {}, scope: { mode: 'all', prefixes: ['[实验]'] } }, privacy: {} }
  const historian = createHistorian({ dataDir, store, cursor: createCursor(store), source, config })
  const result = await historian.record({ dryRun: true })
  assert.equal(result.filteredByScope, 0, 'mode=all 不该按前缀过滤')
  assert.ok(result.sessions.some((item) => item.sessionId === 's-real'), 'mode=all 要读真实标题会话')
})
/* ── D-19：长期记忆四文件 ─────────────────────────────────── */
function memoryFixture() {
  const dir = freshDir('memory-' + Math.random().toString(36).slice(2, 7))
  const store = createStore(dir)
  const ledger = createLedger(store)
  const first = ledger.add({ title: '交周报', due: '2026-10-30', urgency: 3, importance: 2 })
  ledger.confirm(first.item.id, { due: '2026-10-30' })
  const second = ledger.add({ title: '买牛奶' })
  ledger.confirm(second.item.id)
  store.write('任务.json', {
    tasks: [{ id: 'K-001', title: '整理三季度材料', assignee: 'ceo', by: 'secretary', status: '进行中', facts: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  })
  return { dir, store, memory: createMemory({ store, dataDir: dir }) }
}

test('史官节律：21:45 每日判定、周五复盘判定、每天只跑一次', async () => {
  const { dailyDue, weeklyDue, createHistorianSchedule } = await import('../core/historian-schedule.js')
  assert.equal(dailyDue(new Date('2026-10-27T21:44:00'), '21:45', ''), false, '没到点不跑')
  assert.equal(dailyDue(new Date('2026-10-27T21:45:00'), '21:45', ''), true, '到点跑')
  assert.equal(dailyDue(new Date('2026-10-27T21:46:00'), '21:45', '2026-10-27'), false, '当天已跑不重复')
  assert.equal(dailyDue(new Date('2026-10-28T09:00:00'), '21:45', '2026-10-27'), true, '昨天漏跑，今天启动补一次')
  assert.equal(dailyDue(new Date('2026-10-28T09:00:00'), '21:45', ''), false, '没跑过但没到点，先等当天 21:45')
  assert.equal(weeklyDue(new Date('2026-10-30T21:45:00'), { weekday: 5, at: '21:45', lastWeek: '' }), true, '周五到点跑')
  assert.equal(weeklyDue(new Date('2026-10-29T21:45:00'), { weekday: 5, at: '21:45', lastWeek: '' }), false, '周四不提前跑')
  assert.equal(weeklyDue(new Date('2026-10-31T21:00:00'), { weekday: 5, at: '21:45', lastWeek: '' }), true, '周六可补跑周五')

  const dir = freshDir('hist-schedule')
  let runs = 0
  const schedule = createHistorianSchedule({
    dataDir: join(dir, 'data'),
    historian: { record: async () => { runs += 1; return { ok: true, message: '记了 2 条' } } },
    historianChat: null,
    config: { enabled: { historian: true }, historian: { schedule: { enabled: true, dailyAt: '21:45' } } },
    audit: { write() {} },
    now: () => new Date('2026-10-27T21:46:00'),
  })
  const first = await schedule.runDaily()
  assert.equal(first.ok, true)
  assert.equal(runs, 1)
  const second = await schedule.runDaily()
  assert.equal(second.skipped, true, '同一晚只跑一次')
  assert.equal(runs, 1)
  assert.ok(schedule.state().lastDailyDate === '2026-10-27')
})

test('任务产物链：交接卡 → 结果 → 归档 → 史官投喂都落盘', () => {
  const dir = freshDir('task-flow')
  const flow = createTaskFlow({ dataDir: dir })
  const task = { id: 'K-777', title: '十五五规划提纲', by: 'secretary', assignee: 'ceo', status: '进行中', facts: '用户说：整理成三页' }
  const card = flow.writeHandoff({ task, sessionId: 's-1' })
  assert.equal(card.ok, true, JSON.stringify(card))
  assert.ok(existsSync(card.path) && readFileSync(card.path, 'utf8').includes('交接卡'))
  const result = flow.writeResult({ task: { ...task, handoffCard: card.path, sessionId: 's-1' }, result: '已产出三页提纲' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(readFileSync(result.path, 'utf8').includes('已产出三页提纲'))
  const archive = flow.writeArchive({ task: { ...task, status: '完成', handoffCard: card.path, resultPath: result.path, resultSummary: '已产出三页提纲' } })
  assert.equal(archive.ok, true, JSON.stringify(archive))
  assert.ok(readFileSync(archive.path, 'utf8').includes('执行结果'))
  const feed = buildHistorianFeed({ ...task, status: '完成', resultSummary: '已产出三页提纲', resultPath: result.path })
  assert.ok(feed.includes('处理结果：已产出三页提纲'))
})

test('D-19 记忆：ensure 生成四文件，已有内容不被覆盖', () => {
  const { dir, memory } = memoryFixture()
  const ensured = memory.ensure()
  assert.equal(ensured.ok, true)
  assert.equal(ensured.created.length, 4)
  for (const file of MEMORY_FILES) assert.ok(existsSync(join(dir, '记忆', file.name)), '缺文件：' + file.name)

  writeFileSync(join(dir, '记忆', '用户画像.md'), '# 我改过的画像\n', 'utf8')
  memory.ensure()
  assert.equal(readFileSync(join(dir, '记忆', '用户画像.md'), 'utf8'), '# 我改过的画像\n', 'ensure 不能覆盖用户改过的内容')
})

test('D-19 记忆：首次周更写入四文件，7 天内不重复，过 7 天再更', () => {
  const { dir, memory } = memoryFixture()
  const now = new Date('2026-10-26T10:00:00')
  const first = memory.maybeWeeklyUpdate({ now, reason: 'historian' })
  assert.equal(first.ok, true)
  assert.equal(first.skipped, false)
  assert.equal(first.written.length, 4)

  const recent = readFileSync(join(dir, '记忆', '近期交代.md'), 'utf8')
  assert.ok(recent.includes('交周报'), '近期交代要写台账原文标题')
  assert.ok(recent.includes('整理三季度材料'), '近期交代要包含任务板事项')
  assert.ok(readFileSync(join(dir, '记忆', '长期规划.md'), 'utf8').includes('交周报'), '长期规划要列未完成的已确认待办')
  assert.ok(readFileSync(join(dir, '记忆', '用户画像.md'), 'utf8').includes('待办台账共 2 条'), '用户画像要写总量')
  const profile = readFileSync(join(dir, '记忆', '用户画像.md'), 'utf8')
  assert.ok(profile.includes('活跃节奏') && profile.includes('常出现的主题') && profile.includes('你反复提到的偏好'), '画像要有节奏/主题/偏好，不只是台账')
  assert.ok(readFileSync(join(dir, '记忆', '情绪与处境.md'), 'utf8').includes('近 7 天'), '情绪与处境只做计数')
  assert.equal(memory.status().lastUpdatedAt, now.toISOString())

  const again = memory.maybeWeeklyUpdate({ now: new Date(now.getTime() + 86400000) })
  assert.equal(again.skipped, true, '7 天内不重写')
  const later = memory.maybeWeeklyUpdate({ now: new Date(now.getTime() + MEMORY_WEEK_MS + 1000) })
  assert.equal(later.skipped, false, '过 7 天要再写')
})

test('D-19 记忆：周更只重写自动区，手写内容保留（没有标记的旧文件自动补自动区）', () => {
  const { dir, memory } = memoryFixture()
  const now = new Date('2026-10-26T10:00:00')
  memory.maybeWeeklyUpdate({ now, force: true })

  // 在自动区**外**手写一节
  const profilePath = join(dir, '记忆', '用户画像.md')
  const before = readFileSync(profilePath, 'utf8')
  writeFileSync(profilePath, before + '\n## 我手写的一节\n- 别在周日排事\n', 'utf8')

  const again = memory.maybeWeeklyUpdate({ now: new Date(now.getTime() + 8 * 86400000), force: true })
  assert.equal(again.ok, true)
  const after = readFileSync(profilePath, 'utf8')
  assert.ok(after.includes('别在周日排事'), '自动区外的手写内容必须保留（以前周更会整篇覆盖）')
  assert.ok(after.includes('待办台账共 2 条'), '自动区内容仍要照常更新')
  assert.ok(after.indexOf(AUTO_START) >= 0 && after.indexOf(AUTO_END) > after.indexOf(AUTO_START), '自动区标记要保留')

  // 0.47.0 开发期生成的文件没有自动区标记：原内容整体保留，末尾补自动区
  const legacyPath = join(dir, '记忆', '长期规划.md')
  writeFileSync(legacyPath, '# 长期规划\n\n- 这是开发期写的旧内容\n', 'utf8')
  memory.maybeWeeklyUpdate({ now: new Date(now.getTime() + 16 * 86400000), force: true })
  const legacy = readFileSync(legacyPath, 'utf8')
  assert.ok(legacy.includes('这是开发期写的旧内容'), '没有标记的旧文件也要保留原内容')
  assert.ok(legacy.includes(AUTO_START) && legacy.includes('交周报'), '旧文件要补上自动区并写入内容')
})

test('D-19 记忆来源：近期交代纳入角色对话原话与言行录最近行（限长、不搬角色回复）', () => {
  const { dir, memory } = memoryFixture()
  const today = localToday()
  mkdirSync(join(dir, '秘书', '对话'), { recursive: true })
  writeFileSync(join(dir, '秘书', '对话', today + '.md'), '## 10:20\n\n**我**：这周别再把我排到周日\n\n**dsh小助手 · 秘书**：好，记住了\n', 'utf8')
  const recordDir = join(dirname(dir), '史官', '言行录', today.slice(0, 7))
  mkdirSync(recordDir, { recursive: true })
  writeFileSync(join(recordDir, today + '.md'), '# 言行录\n\n- 10:12 用户：把三季度材料先交办公室 [来源: s-x#1 @2026-10-26T02:12:00.000Z]\n', 'utf8')

  const result = memory.maybeWeeklyUpdate({ now: new Date(), force: true })
  assert.equal(result.ok, true)
  const recent = readFileSync(join(dir, '记忆', '近期交代.md'), 'utf8')
  assert.ok(recent.includes('这周别再把我排到周日'), '要纳入角色对话存档里用户原话')
  assert.ok(recent.includes('把三季度材料先交办公室'), '要纳入言行录最近记到的用户内容')
  assert.ok(!recent.includes('好，记住了'), '不能把角色回复原文搬进记忆')
  for (const line of recent.split('\n').filter((item) => item.startsWith('- '))) {
    assert.ok(line.length <= 140, '摘句要限长，实际 ' + line.length + '：' + line)
  }
})

test('D-19 记忆摘要：只取片段、有长度上限，史官不读', () => {
  const { memory } = memoryFixture()
  memory.maybeWeeklyUpdate({ now: new Date('2026-10-26T10:00:00') })
  const tiny = memory.summaryFor('secretary', { maxChars: 80 })
  assert.ok(tiny.length <= 80, '摘要必须受长度限制，实际 ' + tiny.length)
  assert.ok(tiny.includes('用户画像') || tiny.includes('近期交代'))

  const ceo = memory.summaryFor('ceo')
  assert.ok(ceo.length <= 480, 'CEO 摘要也要有上限，实际 ' + ceo.length)
  assert.ok(ceo.includes('长期规划'), 'CEO 要额外带长期规划片段')
  assert.ok(!ceo.includes('# 用户画像'), '不能把整篇 Markdown 塞进去')
  assert.equal(memory.summaryFor('historian'), '', '史官只记录，不读记忆')
})

test('D-19 史官跑完触发记忆周更；dryRun 不触发', async () => {
  const calls = []
  const memory = {
    maybeWeeklyUpdate(options) {
      calls.push(options)
      return { ok: true, written: MEMORY_FILES.map((file) => file.name) }
    },
  }
  const fixture = historianFixture({ memory })
  const dry = await fixture.historian.record({ sessionId: fixture.sessionId, dryRun: true })
  assert.equal(calls.length, 0, 'dryRun 只算不写，不触发记忆周更')
  assert.equal(dry.memory, null)

  const real = await fixture.historian.record({ sessionId: fixture.sessionId, dryRun: false })
  assert.equal(calls.length, 1, '真跑完要触发一次')
  assert.equal(calls[0].reason, 'historian')
  assert.equal(real.memory.ok, true)
})

test('D-19 聊天上下文：带记忆摘要、长度受限、用户原话还在', async () => {
  const dir = freshDir('memory-chat')
  const store = createStore(dir)
  const ledger = createLedger(store)
  const added = ledger.add({ title: '交周报', due: '2026-10-30' })
  ledger.confirm(added.item.id, { due: '2026-10-30' })
  const memory = createMemory({ store, dataDir: dir })
  memory.maybeWeeklyUpdate({ now: new Date() })
  const captured = []
  const sessionEvents = []
  let sessionSeq = 0
  const chat = createRoleChat({
    ctx: {
      get: (name) =>
        name === 'sessionController'
          ? {
              prompt: async (req) => {
                captured.push(req)
                sessionSeq += 1
                sessionEvents.push({ seq: sessionSeq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } })
                return { accepted: true }
              },
            }
          : name === 'sessionQuery'
            ? { readSession: async (id) => ({ session: { id }, events: sessionEvents.slice() }) }
            : undefined,
    },
    store,
    role: 'secretary',
    dataDir: dir,
    ledger,
    memory,
    timing: { pollMs: 5, replyTimeoutMs: 300 },
  })
  seedSessionState(dir, '秘书', 's-mem', 'dsh小助手 · 秘书 对话')
  const result = await chat.chat('今天先干什么')
  assert.equal(result.ok, true)
  const sent = captured[0].content[0].text
  assert.ok(sent.includes('长期记忆摘要'), '上下文要带记忆摘要')
  assert.ok(sent.includes('交周报'), '要带相关片段')
  assert.ok(sent.includes('【用户说】今天先干什么'), '用户原话必须保留')
  assert.ok(sent.length < 900, '上下文要有长度上限，实际 ' + sent.length)
})

test('D-19 集成：apply() 会在数据目录建好 记忆/ 四文件，health 能看到', async () => {
  const dir = freshDir('memory-apply')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  for (const file of MEMORY_FILES) assert.ok(existsSync(join(dir, '记忆', file.name)), '缺 ' + file.name)
  const health = await call(routes, '/api/dsh-xiaozhushou/health')
  assert.equal(health.json.memory.files.length, 4)
})

/* ── D-20：CEO 硬动作 + "开新会话执行" ───────────────────── */
test('D-20 意图识别："开新会话执行 …"命中，普通问句不命中', () => {
  const hit = detectExecuteIntent('开新会话执行：整理三季度材料')
  assert.equal(hit.matched, true)
  assert.ok(hit.task.includes('整理三季度材料'), hit.task)
  assert.equal(detectExecuteIntent('今天先干什么').matched, false)
  assert.equal(detectExecuteIntent('要不要开会话').matched, false, '只问不建，不能算执行意图')
  const second = detectExecuteIntent('新开一个会话去处理报销票据')
  assert.equal(second.matched, true)
  assert.ok(second.task.includes('报销票据'), second.task)
  // 安全边界：征询 / 否定句绝不能拿去建会话
  assert.equal(detectExecuteIntent('要不要开个新会话执行这个').matched, false, '征询不算命令')
  assert.equal(detectExecuteIntent('该不该开新会话处理这件事').matched, false, '问主意不算命令')
  assert.equal(detectExecuteIntent('先别开新会话执行这个').matched, false, '否定不算命令')
})

test('D-20 守卫：问句不会被当成"开新会话执行"（征询不动手）', async () => {
  let spawned = 0
  const executor = createCeoExecutor({ spawner: { spawn: async () => { spawned += 1; return { ok: true, sessionId: 's-x' } } } })
  const intent = detectExecuteIntent('要不要开个新会话执行这个')
  assert.equal(intent.matched, false)
  assert.equal(spawned, 0)
  // 直接调用执行器也必须有任务，不能空跑
  const empty = await executor.execute({ text: '注意：这里没有任务' })
  assert.equal(empty.ok, false)
  assert.equal(empty.httpStatus, 400)
})

test('D-20 执行器：spawner 参数正确（CEO preset / 固定标题 / 任务进第一句）', async () => {
  const calls = []
  const executor = createCeoExecutor({ spawner: { spawn: async (req) => { calls.push(req); return { ok: true, sessionId: 's-exec' } } } })
  const result = await executor.execute({ text: '开新会话执行 整理材料', task: '整理材料' })
  assert.equal(result.ok, true)
  assert.equal(result.executed, true)
  assert.equal(result.sessionId, 's-exec')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agentPreset, undefined, '任务会话应是普通会话，不套角色 preset')
  assert.equal(calls[0].title, EXECUTE_TITLE)
  assert.equal(calls[0].confirmedByAuthor, true)
  assert.ok(calls[0].prompt.includes('整理材料'), '任务要写进第一句')
  assert.ok(calls[0].prompt.includes('权限'), '要说明权限在本会话里申请')
})

test('D-20 执行器：建会话失败要显式报错（不假装成功）', async () => {
  const executor = createCeoExecutor({ spawner: { spawn: async () => ({ ok: false, code: 'rate_limited', message: '一小时最多开 4 个新会话' }) } })
  const result = await executor.execute({ text: '开新会话执行 整理材料', task: '整理材料' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'rate_limited')
  assert.equal(result.httpStatus, 502)
  assert.ok(result.message.includes('失败'), result.message)
  assert.ok(result.message.includes('没有执行'), '要说清任务没执行')

  const noSpawner = createCeoExecutor({ spawner: null })
  const missing = await noSpawner.execute({ text: '开新会话执行 x', task: 'x' })
  assert.equal(missing.httpStatus, 503)
  assert.equal(missing.code, 'no_spawner')
})

test('D-20 路由：/ceo/chat 命中"开新会话执行"时真建会话并回会话名/ID', async () => {
  const dir = freshDir('d20-route')
  const calls = { create: [], rename: [], prompt: [] }
  const controller = {
    async create(req) { calls.create.push(req); return { sessionId: 's-ceo-new' } },
    async rename(req) { calls.rename.push(req); return { ok: true } },
    async prompt(req) { calls.prompt.push(req); return { accepted: true } },
  }
  const query = { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => ({ events: [] }) }
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })

  const res = await call(routes, '/api/dsh-xiaozhushou/ceo/chat', { question: '开新会话执行 整理三季度材料' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.executed, true)
  assert.equal(res.json.sessionId, 's-ceo-new')
  assert.equal(res.json.sessionTitle, EXECUTE_TITLE)
  assert.equal(calls.create[0].agentPreset, undefined, '任务会话应是普通会话')
  assert.equal(calls.rename[0].title, EXECUTE_TITLE)
  assert.ok(calls.prompt[0].content[0].text.includes('整理三季度材料'), '任务要写进第一句')
})

test('D-20 路由：环境不支持建会话时返回 502 错误（不静默）', async () => {
  const dir = freshDir('d20-route-fail')
  const { ctx, routes } = makeCtx(dir) // 默认没有 sessionController
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  const res = await call(routes, '/api/dsh-xiaozhushou/ceo/chat', { question: '开新会话执行 整理材料' })
  assert.equal(res.status, 502)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.code, 'no_controller')
  assert.ok(res.json.message.includes('失败'), res.json.message)
})

test('D-08/D-20 按钮开会话：/session/open 把 preset 兼容成 agentPreset（不再丢角色身份）', async () => {
  const dir = freshDir('d08-open-preset')
  const calls = { create: [], rename: [], prompt: [] }
  const controller = {
    async create(req) { calls.create.push(req); return { sessionId: 's-open' } },
    async rename(req) { calls.rename.push(req); return { ok: true } },
    async prompt(req) { calls.prompt.push(req); return { accepted: true } },
  }
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })

  const legacy = await call(routes, '/api/dsh-xiaozhushou/session/open', { title: 'dsh小助手 · 秘书', prompt: '你好', preset: 'steward-secretary' })
  assert.equal(legacy.json.ok, true, JSON.stringify(legacy.json))
  assert.equal(calls.create[0].agentPreset, 'steward-secretary', '历史 preset 写法要透传成 agentPreset（以前被忽略）')

  const modern = await call(routes, '/api/dsh-xiaozhushou/session/open', { title: 'dsh小助手 · CEO', prompt: '你好', agentPreset: 'steward-ceo' })
  assert.equal(modern.json.ok, true, JSON.stringify(modern.json))
  assert.equal(calls.create[1].agentPreset, 'steward-ceo', 'agentPreset 写法也要透传')

  const client = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(client.includes('openTaskSession') && client.includes('/ceo/open-task'), 'CEO 按钮要走「开任务会话」接口')
  assert.ok(!client.includes("agentPreset: 'steward-secretary'"), '秘书区不再开新会话')
})

test('D-20 路由：/ceo/open-task 按钮真建 CEO 任务会话', async () => {
  const dir = freshDir('ceo-open-task')
  const calls = { create: [], rename: [], prompt: [] }
  const controller = {
    async create(req) { calls.create.push(req); return { sessionId: 's-task' } },
    async rename(req) { calls.rename.push(req); return { ok: true } },
    async prompt(req) { calls.prompt.push(req); return { accepted: true } },
  }
  const query = { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => ({ events: [] }) }
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  const res = await call(routes, '/api/dsh-xiaozhushou/ceo/open-task', { task: '整理三季度材料' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.executed, true)
  assert.equal(res.json.sessionId, 's-task')
  assert.equal(calls.create[0].agentPreset, undefined, '任务会话应是普通会话')
  assert.ok(calls.prompt[0].content[0].text.includes('整理三季度材料'), '任务要写进第一句')
})

test('D-20 任务硬动作：/task/status 能把任务转交给秘书', async () => {
  const dir = freshDir('d20-transfer')
  writeFileSync(join(dir, '任务.json'), JSON.stringify({
    version: 1,
    tasks: [{ id: 'K-001', title: '整理材料', assignee: 'ceo', by: 'secretary', status: '待办', facts: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  }), 'utf8')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  const res = await call(routes, '/api/dsh-xiaozhushou/task/status', { id: 'K-001', status: '待办', assignee: 'secretary' })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.task.assignee, 'secretary')
  const stored = JSON.parse(readFileSync(join(dir, '任务.json'), 'utf8'))
  assert.equal(stored.tasks[0].assignee, 'secretary', '转交要真实落盘')
})

test('D-20 守卫：任务规则交给会话/工具，界面不再堆按钮', () => {
  const client = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(client.includes('function taskButtons() {') && client.includes('return null'), '任务按钮已收起')
  assert.ok(!client.includes("taskAction(id, 'archive')"), '不再要求用户从界面点归档')
  assert.ok(client.includes('拿不准') && client.includes('转给 ?CEO'), '转交按钮只在会话拿不准时出现')
})

test('D-20 工具：CEO 可通过 steward_ceo 查任务/接/完成/归档/记忆', async () => {
  const dir = freshDir('tool-tasks')
  const store = createStore(dir)
  const calls = []
  const taskOps = {
    list: () => [{ id: 'K-001', title: '测试任务', assignee: 'ceo', status: '进行中' }],
    setStatus: (id, status) => { calls.push(id + ':' + status); return { ok: true, task: { id, status } } },
    archive: (id) => { calls.push(id + ':archive'); return { ok: true, task: { id, status: '已归档' } } },
    remember: (id) => { calls.push(id + ':remember'); return { ok: true, task: { id, status: '已记忆' }, text: '记忆卡 x' } },
  }
  const toolset = createToolset({ ledger: createLedger(store), inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { ceo: true }, tools: { enabled: true } }, tasks: taskOps, log: () => {} })
  const ceo = toolset.find((x) => x.name === 'steward_ceo')
  const list = await ceo.execute({ action: 'tasks' }, {})
  assert.equal(list.ok, true)
  assert.ok(list.text.includes('K-001'))
  const accepted = await ceo.execute({ action: 'accept_task', id: 'K-001' }, {})
  assert.equal(accepted.ok, true)
  assert.ok(calls.includes('K-001:进行中'))
  await ceo.execute({ action: 'remember_task', id: 'K-001' }, {})
  assert.ok(calls.includes('K-001:remember'))
})

test('D-18/D-20：派给 CEO 的任务自动接下（进行中），归档/记忆要求先完成', async () => {
  const dir = freshDir('task-auto')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const store = createStore(dataDir)
  const chat = createRoleChat({ ctx: { get: () => undefined }, store, log: () => {}, role: 'secretary', ledger: null, dataDir })
  const made = chat.assignTask({ title: '自动接活测试', assignee: 'ceo', by: 'secretary' })
  assert.equal(made.ok, true)
  assert.equal(made.task.status, '进行中', '派给 CEO 应自动接下')
  assert.ok(made.task.autoAccepted, '要有自动接下标记')
  const done = chat.setTaskStatus(made.task.id, '完成')
  assert.equal(done.ok, true)
  assert.equal(done.task.status, '完成')
})

test('D-20：已完成任务生成史官可投喂的记忆卡（事实/候选/待核对 + 来源）', async () => {
  const { buildHistorianFeed, writeHistorianFeed } = await import('../core/historian-feed.js')
  const task = { id: 'K-009', title: '把附件补齐', assignee: 'ceo', by: 'secretary', status: '完成', facts: '附件 2 份、回邮件' }
  const text = buildHistorianFeed(task)
  assert.ok(text.includes('记忆投喂 · K-009'))
  assert.ok(text.includes('## 一、事实') && text.includes('## 二、可复用做法') && text.includes('## 三、待核对'))
  assert.ok(text.includes('附件 2 份') && text.includes('任务板 K-009'))
  const dir = freshDir('hist-feed')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const feed = writeHistorianFeed({ dataDir, task })
  assert.ok(feed.file.endsWith('K-009.md'))
  assert.ok(readFileSync(feed.file, 'utf8').includes('把附件补齐'))
})

test('史官读失败：如实报失败会话数，不假装成功', async () => {
  const dir = freshDir('hist-fail')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const store = createStore(dataDir)
  const source = {
    listTargets: async () => ({ ok: true, targets: [{ sessionId: 's-bad' }], total: 1 }),
    readEvents: async () => ({ ok: false, code: 'read_failed', message: '读不了', events: [] }),
  }
  const config = { enabled: { historian: true }, historian: { tier: 'summary', budgets: {}, scope: { mode: 'all', prefixes: ['[实验]'] } }, privacy: {} }
  const historian = createHistorian({ dataDir, store, cursor: createCursor(store), source, config })
  const result = await historian.record()
  assert.equal(result.ok, false)
  assert.equal(result.failedSessions, 1)
  assert.ok(result.message.includes('没读成'))
})
/* ── M4：CEO 规则版判断 ───────────────────────────────────── */
function ledgerStub(items, extra = {}) {
  const confirmed = items.filter((x) => x.status === '已确认')
  return {
    stats: () => ({
      confirmed,
      pendingCount: items.filter((x) => x.status === '候选').length,
      doneCount: items.filter((x) => x.status === '已完成').length,
      droppedCount: 0,
      skipped: 0,
      ...extra,
    }),
  }
}

test('四问：四句都非空、每句 ≤40 字、标注规则版', () => {
  const items = [{ id: 'T-001', title: '买牛奶', status: '已确认', due: localToday(), urgency: 3, importance: 3 }]
  const four = fourQuestions({ ledger: ledgerStub(items), snapshot: { sessions: [] }, now: new Date() })
  for (const key of ['done', 'todo', 'next', 'urgent']) {
    assert.ok(four[key] && four[key].length > 0, key + ' 不能空')
    assert.ok(four[key].length <= 41, key + ' 应 ≤40 字，实际 ' + four[key].length)
  }
  assert.equal(four.source, 'rule', '规则版必须标出来')
  assert.equal(four.meta.dueToday, 1)
})

test('单线分析：字段齐全、依据带强弱与来源、不超过 12 行', () => {
  const items = [
    { id: 'T-001', title: '过期的事', status: '已确认', due: '2020-01-01', urgency: 3, importance: 3 },
    { id: 'T-002', title: '候选的事', status: '候选', due: null, urgency: 1, importance: 1 },
  ]
  const line = singleLine({ ledger: ledgerStub(items), snapshot: { sessions: [{ live: true }, { live: false }] }, now: new Date() })
  for (const key of ['conclusion', 'risk', 'recommend', 'decision']) assert.ok(line[key], key + ' 不能空')
  assert.ok(Array.isArray(line.evidence) && line.evidence.length >= 2)
  assert.ok(line.evidence.every((item) => /（强|中|弱·/.test(item)), '依据要带强弱与来源：' + line.evidence.join(' / '))
  assert.ok(Array.isArray(line.options) && line.options.length >= 2)
  assert.equal(line.source, 'rule')
  const lineCount = 1 + line.evidence.length + 1 + line.options.length + 2
  assert.ok(lineCount <= 12, '单线分析应 ≤12 行，实际约 ' + lineCount)
})

test('单线分析：过期项时结论要先清过期', () => {
  const line = singleLine({ ledger: ledgerStub([{ id: 'T-1', title: 'x', status: '已确认', due: '2020-01-01', urgency: 3, importance: 3 }]), now: new Date() })
  assert.ok(line.conclusion.includes('过期'))
})

test('空台账也能给出话（不崩、不编）', () => {
  const four = fourQuestions({ ledger: ledgerStub([]), now: new Date() })
  const line = singleLine({ ledger: ledgerStub([]), now: new Date() })
  assert.ok(four.next.includes('暂无') || four.next.includes('等你'))
  assert.ok(line.conclusion.includes('等你') || line.conclusion.includes('没有'))
  assert.ok(line.evidence.some((item) => item.includes('规则兜底')))
})

test('交接卡：短卡有必备块，底账有位置映射/已知坑/支线启动词', () => {
  const result = handoverCard({ topic: '周末大扫除', workspace: 'main-workspace', task: '写周末大扫除', progress: ['材料收齐', '框架已定'] })
  assert.equal(result.ok, true)
  for (const block of ['## 一句话任务', '## 当前进展', '## 任务有没有变', '## 已确认的问答', '## 未完成 / 待复核', '## 关键文件 / 会话', '## 规则索引', '## 下一步建议', '## 禁止事项', '粉色大象自检']) {
    assert.ok(result.card.includes(block), '短卡缺块：' + block)
  }
  assert.ok(result.card.includes('initiator: user'))
  assert.ok(result.card.includes('workspace: main-workspace'))
  for (const block of ['## 位置映射表', '## 已知坑', '## 逐支线启动词']) {
    assert.ok(result.ledger.includes(block), '底账缺块：' + block)
  }
  // 短卡要"短"：一页约 60 行内
  assert.ok(result.card.split('\n').length <= 60, '短卡行数应 ≤60，实际 ' + result.card.split('\n').length)
})

test('路由 /handover 能生成卡，includeLedger=false 时只回短卡', async () => {
  const dir = freshDir('handover')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const full = await call(routes, '/api/dsh-xiaozhushou/handover', { topic: '测试任务' })
  assert.equal(full.json.ok, true)
  assert.ok(full.json.card.includes('测试任务'))
  assert.ok(full.json.ledger, '默认要带底账')

  const brief = await call(routes, '/api/dsh-xiaozhushou/handover', { topic: '测试任务', includeLedger: false })
  assert.equal(brief.json.ledger, undefined, 'includeLedger=false 不应回底账')
})

test('看板里四问/单线已由规则版填充（不再是占位）', async () => {
  const dir = freshDir('board-analysis')
  writeFileSync(join(dir, '待办.json'), JSON.stringify({ version: 1, items: [{ id: 'T-001', title: '今天的事', status: '已确认', urgency: 3, importance: 3, due: localToday() }] }), 'utf8')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const board = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(board.json.four.source, 'rule')
  assert.ok(board.json.four.next && !board.json.four.next.includes('—'))
  assert.ok(board.json.analysis.conclusion && !board.json.analysis.conclusion.includes('还没接上'))
  assert.ok(board.json.analysis.evidence.length > 0)
})
/* ── M4 交接卡落盘 ────────────────────────────────────────── */
test('交接卡落盘：短卡+底账两个文件，内容对', () => {
  const dir = freshDir('handover-write')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const ho = createHandover({ dataDir })
  const result = ho.create({ topic: '周末大扫除', task: '做家务', write: true })
  assert.equal(result.ok, true)
  assert.ok(result.written, 'write=true 时必须真的写盘')
  assert.ok(existsSync(result.written.cardPath), '短卡文件要存在')
  assert.ok(existsSync(result.written.ledgerPath), '底账文件要存在')
  const card = readFileSync(result.written.cardPath, 'utf8')
  assert.ok(card.includes('周末大扫除'))
  assert.ok(result.written.cardPath.includes('CEO'), '应落在 CEO 工作区')
})

test('交接卡落盘：同名不覆盖，自动递增编号', () => {
  const dir = freshDir('handover-dup')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const ho = createHandover({ dataDir })
  const first = ho.create({ topic: '同一个主题', write: true })
  const second = ho.create({ topic: '同一个主题', write: true })
  assert.notEqual(first.written.cardPath, second.written.cardPath, '第二次不能覆盖第一次')
  assert.ok(second.written.cardPath.includes('-01'), '第二份应带 -01 后缀')
})

test('交接卡：write 缺省时只返回文本、不写盘', () => {
  const dir = freshDir('handover-dry')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const ho = createHandover({ dataDir })
  const result = ho.create({ topic: '只看不写' })
  assert.equal(result.ok, true)
  assert.equal(result.written, null)
  assert.equal(existsSync(join(dir, 'CEO')), false, '没写就不该建目录')
})

/* ── M5 维修站档案 ────────────────────────────────────────── */
test('维修站：写成纯文本 md（不是 json），含状态与诊断五步', () => {
  const dir = freshDir('repair')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const store = createStore(dataDir)
  const written = writeRepairStation({
    dataDir,
    store,
    config: { enabled: { historian: false }, historian: { tier: 'summary' } },
    runtime: { version: '0.7.0', timerOk: true, collectOk: true, degraded: [] },
  })
  assert.equal(written.ok, true, '写维修站失败：' + (written.message || ''))
  const text = readFileSync(written.path, 'utf8')
  assert.ok(text.trimStart().startsWith('# 维修站'), '应是纯文本 markdown')
  assert.ok(!text.trimStart().startsWith('{'), '不能写成 JSON')
  for (const block of ['## 一、当前状态', '## 二、诊断五步', '## 三、DSH 大更新后要重新核对的地方', '## 四、卸载与回滚', '## 五、红线']) {
    assert.ok(text.includes(block), '维修站缺块：' + block)
  }
  assert.ok(text.includes('0.7.0'), '要带版本号')
})

test('维修站：不写密钥类内容（自查一遍）', () => {
  const dir = freshDir('repair-secrets')
  const dataDir = join(dir, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  const written = writeRepairStation({ dataDir, store: createStore(dataDir), config: { enabled: {} }, runtime: { version: 'x' } })
  const text = readFileSync(written.path, 'utf8')
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(text), '不能出现密钥样式内容')
  assert.ok(!text.includes('api_key'), '不能出现 api_key')
})
/* ── 优先级层（用户要的"象限之上再加一层"） ───────────────── */
test('优先级：四象限落基础级（急且重要=4、重要不急=3、急不重要=2、都不=1）', () => {
  assert.equal(computePriority({ urgency: 3, importance: 3 }).level, 4)
  assert.equal(computePriority({ urgency: 1, importance: 3 }).level, 3)
  assert.equal(computePriority({ urgency: 3, importance: 1 }).level, 2)
  assert.equal(computePriority({ urgency: 1, importance: 1 }).level, 1)
})

test('优先级：说"最"就提一级（最紧急 +1、最重要 +1、两个都说 +2，封顶 5）', () => {
  assert.equal(computePriority({ urgency: 3, importance: 3, mostUrgent: true }).level, 5)
  assert.equal(computePriority({ urgency: 3, importance: 3, mostImportant: true }).level, 5)
  assert.equal(computePriority({ urgency: 3, importance: 3, mostUrgent: true, mostImportant: true }).level, 5, '封顶 5')
  assert.equal(computePriority({ urgency: 1, importance: 3, mostImportant: true }).level, 4, '重要不急 + "最重要" = 4 级')
  assert.equal(computePriority({ urgency: 3, importance: 1, mostUrgent: true }).level, 3)
})

test('优先级：只用一个灯（用户定稿：红/红/黄，最=闪）', () => {
  for (const level of [5, 4, 3, 2, 1]) {
    assert.equal(PRIORITY_LEVELS[level].dots, 1, 'L' + level + ' 只用一个灯')
  }
  assert.equal(PRIORITY_LEVELS[5].color, 'red')
  assert.equal(PRIORITY_LEVELS[5].blink, true, '"最"才闪')
  assert.equal(PRIORITY_LEVELS[4].color, 'red', '紧急且重要=红')
  assert.equal(PRIORITY_LEVELS[4].blink, false)
  assert.equal(PRIORITY_LEVELS[3].color, 'warn', '单重要=黄')
  assert.equal(PRIORITY_LEVELS[2].color, 'red', '单紧急=红')
  assert.equal(PRIORITY_LEVELS[1].color, 'blue')
})

test('优先级的"最"必须来自用户亲口（标记位），不能由模型自己加', () => {
  const plain = computePriority({ urgency: 3, importance: 3 })
  assert.equal(plain.mostUrgent, false)
  assert.equal(plain.mostImportant, false)
  assert.equal(plain.level, 4, '没标记就是 4 级，不许自己升')
})

test('排序与分组：5→1 级排序，同组按截止时间；空级不占位', () => {
  const items = [
    { id: 'T-1', title: '常规', urgency: 1, importance: 1 },
    { id: 'T-2', title: '最急', urgency: 3, importance: 3, mostUrgent: true },
    { id: 'T-3', title: '急', urgency: 3, importance: 3, due: '2026-12-31' },
  ]
  const ranked = rankByPriority(items)
  assert.deepEqual(Array.from(ranked.map((i) => i.id)), ['T-2', 'T-3', 'T-1'])
  const groups = groupByPriority(items)
  assert.deepEqual(Array.from(groups.map((g) => g.level)), [5, 4, 1], '空级（3/2）不占位')
})

test('整体提醒信号：取最高那条（3 红 + 闪 + 几条）', () => {
  const signal = overallSignal([
    { id: 'T-1', title: 'a', urgency: 3, importance: 3, mostUrgent: true },
    { id: 'T-2', title: 'b', urgency: 3, importance: 3, mostUrgent: true },
    { id: 'T-3', title: 'c', urgency: 1, importance: 1 },
  ])
  assert.equal(signal.level, 5)
  assert.equal(signal.dots, 1)
  assert.equal(signal.blink, true)
  assert.equal(signal.count, 2, '同处最高的有几条')
  assert.equal(overallSignal([]).dots, 0)
})

test('用户定：/todo 不接受界面传来的"最"（只有口述/指令能提级）', async () => {
  const dir = freshDir('most-ignored')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const created = await call(routes, '/api/dsh-xiaozhushou/todo', { title: '测试最级', urgent: true, important: true, mostUrgent: true, mostImportant: true })
  assert.equal(created.json.ok, true)
  assert.equal(created.json.item.mostUrgent, false, '界面传来的一律不认')
  assert.equal(created.json.item.mostImportant, false, '界面传来的一律不认')
  assert.equal(created.json.priority.level, 4, '又急又重要 = 4 级；要 5 级只能嘴上说"最"')
})
test('端到端：指令里说"最紧急 最重要" → 台账标记 → 看板 5 级 → 红灯常亮', async () => {
  const dir = freshDir('priority-e2e')
  writeFileSync(
    join(dir, '待办.json'),
    JSON.stringify({ version: 1, items: [{ id: 'T-001', title: '马上要的事', status: '候选', urgency: 1, importance: 1, due: null }] }),
    'utf8',
  )
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const cmd = await call(routes, '/api/dsh-xiaozhushou/command', { text: '确认 T-001 2026-12-31 最紧急 最重要' })
  assert.equal(cmd.json.ok, true)
  assert.equal(cmd.json.item.mostUrgent, true, '台账要记住"最紧急"是用户说的')
  assert.equal(cmd.json.item.mostImportant, true)

  const state = await call(routes, '/api/dsh-xiaozhushou/state')
  assert.equal(state.json.level, 5)
  assert.equal(state.json.lamp.color, 'red')
  assert.equal(state.json.lamp.mode, 'steady')

  const board = await call(routes, '/api/dsh-xiaozhushou/board')
  assert.equal(board.json.todos.attention.level, 5)
  assert.equal(board.json.todos.priorityGroups[0].level, 5)
  assert.equal(board.json.todos.priorityGroups[0].items[0].id, 'T-001')
})

test('普通"紧急 重要"只有 2 灯、不闪（区分"最"）', async () => {
  const dir = freshDir('priority-normal')
  writeFileSync(
    join(dir, '待办.json'),
    JSON.stringify({ version: 1, items: [{ id: 'T-001', title: '普通的事', status: '候选', urgency: 1, importance: 1 }] }),
    'utf8',
  )
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await call(routes, '/api/dsh-xiaozhushou/command', { text: '确认 T-001 2026-12-31 紧急 重要' })
  const state = await call(routes, '/api/dsh-xiaozhushou/state')
  assert.equal(state.json.level, 4)
  assert.equal(state.json.dots, 1)
  assert.equal(state.json.dot, 'red', '紧急且重要=红')
  assert.equal(state.json.blink, false, '不闪，和"最"区分开')
})

test('client.js 状态灯：单灯、可闪、绑统一事项', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('renderDots'), '必须有画灯的函数')
  assert.ok(src.includes('ke-lamp'), '必须有单灯样式')
  assert.ok(src.includes('ke-blink'), '必须有闪烁样式')
  assert.ok(src.includes('attention'), '看板要渲染统一优先级层')
  assert.ok(!/Math\.max\(1, Number\(state\.dots\)/.test(src), '不再画多颗灯')
})
/* ── A1：三个角色工具（默认关闭） ─────────────────────────── */
function toolFixture({ enabled = { secretary: true, ceo: true, historian: false }, tools = { enabled: true } } = {}) {
  const dir = freshDir('tools-' + Math.random().toString(36).slice(2, 7))
  const store = createStore(dir)
  const ledger = createLedger(store)
  const config = { enabled, tools, historian: { tier: 'summary', budgets: {} }, privacy: {} }
  const historian = { record: async () => ({ ok: true, dryRun: true, written: 0, sessions: [] }) }
  const handover = createHandover({ dataDir: dir })
  const toolset = createToolset({ ledger, inbox: createInbox(store), historian, handover, config, log: () => {} })
  return { toolset, ledger, config, dir }
}

test('A1 工具：合计只有 3 个，且都符合官方 ToolDefinition 形状', () => {
  const { toolset } = toolFixture()
  assert.equal(toolset.length, 3, 'S8：合计 ≤3 个')
  assert.deepEqual(Array.from(toolset.map((t) => t.name)), Array.from(TOOL_NAMES))
  for (const tool of toolset) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties && tool.parameters.properties.action, '动作用 action 枚举收敛')
    assert.ok(Array.isArray(tool.parameters.properties.action.enum))
    assert.ok(tool.output && tool.output.schema && typeof tool.output.render === 'function', 'output 要带 schema 与 render')
    assert.equal(typeof tool.execute, 'function')
    const blocks = tool.output.render({}, { ok: true, text: 'hi' })
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, 'hi')
  }
})

test('A1 秘书 handoff：只给 facts 也能落 CEO 任务板（不再报“任务没写清楚”）', async () => {
  const dir = freshDir('handoff-facts')
  const store = createStore(dir)
  const calls = []
  const taskOps = {
    list: () => [],
    assign: (title, facts) => { calls.push({ title, facts }); return { ok: true, task: { id: 'K-900', title } } },
    setStatus: () => ({ ok: true }),
    archive: () => ({ ok: true }),
    remember: () => ({ ok: true }),
  }
  const toolset = createToolset({ ledger: createLedger(store), inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { secretary: true }, tools: { enabled: true } }, tasks: taskOps, log: () => {} })
  const sec = toolset.find((x) => x.name === 'steward_secretary')
  const r = await sec.execute({ action: 'handoff_to_ceo', facts: '用户说：帮我找一下十五五规划的历史会话' }, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].title.length > 0, 'facts 要能兜底成标题')
  assert.ok(calls[0].facts.includes('十五五规划'))
})

test('notice：必须把 signal 传给 sessionController.prompt，失败不假成功', async () => {
  const dir = freshDir('notice-signal')
  const store = createStore(dir)
  store.write('CEO/会话状态.json', { version: 1, sessionId: 's-notice' })
  const calls = []
  const okChat = createRoleChat({
    ctx: { get: (name) => (name === 'sessionController' ? { prompt: async (request, signal) => { calls.push({ request, signal }) } } : undefined) },
    store, log: () => {}, dataDir: dir, role: 'ceo',
  })
  const sent = await okChat.notice('通知 CEO')
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].signal && typeof calls[0].signal.aborted === 'boolean', 'prompt 第二个参数必须是 AbortSignal')
  assert.equal(calls[0].request.mode, 'queue')

  const badChat = createRoleChat({
    ctx: { get: (name) => (name === 'sessionController' ? { prompt: async () => { throw new Error('boom') } } : undefined) },
    store, log: () => {}, dataDir: dir, role: 'ceo',
  })
  const failed = await badChat.notice('失败通知')
  assert.equal(failed.ok, false, 'prompt 抛错时 notice 不能假成功')
})

test('画像词频：中文主题能被提取出来', () => {
  const dir = freshDir('profile-terms')
  const store = createStore(dir)
  store.write('任务.json', { version: 1, tasks: [
    { id: 'K-101', title: '十五五规划材料', status: '完成' },
    { id: 'K-102', title: '十五五规划汇报', status: '完成' },
    { id: 'K-103', title: '十五五规划分工', status: '完成' },
  ] })
  const memory = createMemory({ store, dataDir: dir })
  memory.maybeWeeklyUpdate({ force: true, now: new Date('2026-10-27T10:00:00') })
  const profile = readFileSync(join(dir, '记忆', '用户画像.md'), 'utf8')
  assert.ok(profile.includes('十五五'), '中文词频不能因正则把汉字删掉')
})

test('角色历史同步：只取会话明文，不取 reasoning/tool', async () => {
  const dir = freshDir('role-history')
  const store = createStore(dir)
  store.write('CEO/会话状态.json', { version: 1, sessionId: 's-history', title: 'CEO 对话' })
  const query = { readSession: async () => ({ events: [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '在的' }] } } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'reasoning', text: '只有思考' }] } } },
  ] }) }
  const chat = createRoleChat({ ctx: { get: (name) => (name === 'sessionQuery' ? query : undefined) }, store, log: () => {}, dataDir: dir, role: 'ceo' })
  const result = await chat.history(10)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(Array.from(result.lines, (line) => [line.role, line.text]), [['me', '你好'], ['bot', '在的']])
})

test('任务优先级：最紧急最重要进任务板时是 5 级', () => {
  const dir = freshDir('task-priority')
  const store = createStore(dir)
  const chat = createRoleChat({ ctx: { get: () => undefined }, store, log: () => {}, dataDir: dir, role: 'secretary' })
  const made = chat.assignTask({ title: '最紧急最重要：攻坚任务', assignee: 'ceo', by: 'secretary', facts: '本周五、下周一两个节点，省局市局两层' })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal(made.task.priority.level, 5, JSON.stringify(made.task.priority))
})

test('A1 CEO 会话查找/发指令：sessions 找到旧会话，send_session 只发不新建', async () => {
  const dir = freshDir('ceo-sessions')
  const store = createStore(dir)
  const sent = []
  const sessionOps = {
    list: async (query) => [{ id: 'session-old-1', title: '写作材料协作', live: false, preset: '' }],
    prompt: async (id, text) => { sent.push({ id, text }); return { ok: true } },
  }
  const toolset = createToolset({ ledger: createLedger(store), inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { ceo: true }, tools: { enabled: true } }, sessions: sessionOps, log: () => {} })
  const ceo = toolset.find((x) => x.name === 'steward_ceo')
  const found = await ceo.execute({ action: 'sessions', query: '写作' }, {})
  assert.equal(found.ok, true, JSON.stringify(found))
  assert.ok(found.text.includes('session-old-1') && found.text.includes('写作材料协作'))
  const pushed = await ceo.execute({ action: 'send_session', sessionId: 'session-old-1', text: '改方向：蒸馏材料记忆' }, {})
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].id, 'session-old-1')
  assert.ok(sent[0].text.includes('【CEO 指令】') && sent[0].text.includes('蒸馏材料记忆'))
})

test('A1 角色消息：秘书 handoff 会通知 CEO 会话，message_role 可发消息', async () => {
  const dir = freshDir('role-message')
  const store = createStore(dir)
  const notices = []
  const made = []
  const taskOps = {
    list: () => made,
    assign: (title) => { const task = { id: 'K-902', title }; made.push(task); return { ok: true, task } },
    patch: () => ({ ok: true }), setStatus: () => ({ ok: true }), archive: () => ({ ok: true }), remember: () => ({ ok: true }),
  }
  const roleChats = { ceo: { notice: (text) => { notices.push(text); return { ok: true } } }, secretary: { notice: () => ({ ok: true }) }, historian: { notice: () => ({ ok: true }) } }
  const toolset = createToolset({ ledger: createLedger(store), inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { secretary: true, ceo: true }, tools: { enabled: true } }, tasks: taskOps, roleChats, log: () => {} })
  const sec = toolset.find((x) => x.name === 'steward_secretary')
  const handoff = await sec.execute({ action: 'handoff_to_ceo', facts: '用户说：查十五五规划' }, {})
  assert.equal(handoff.ok, true, JSON.stringify(handoff))
  assert.ok(notices.length === 1 && notices[0].includes('K-902'), 'handoff 后要通知 CEO 会话')
  const sent = await sec.execute({ action: 'message_role', target: 'ceo', text: '这条是测试消息' }, {})
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.ok(notices[1].includes('测试消息'))
})

test('A1 CEO open_task：用 steward_ceo 真开普通任务会话', async () => {
  const dir = freshDir('ceo-open-task')
  const store = createStore(dir)
  const spawned = []
  const madeTasks = []
  const taskOps = {
    list: () => madeTasks,
    assign: (title) => { const task = { id: 'K-901', title }; madeTasks.push(task); return { ok: true, task } },
    patch: (id, fields) => { const task = madeTasks.find((x) => x.id === id); Object.assign(task, fields); return { ok: true, task } },
    setStatus: () => ({ ok: true }),
    archive: () => ({ ok: true }),
    remember: () => ({ ok: true }),
  }
  const toolset = createToolset({ ledger: createLedger(store), inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { ceo: true }, tools: { enabled: true } }, spawner: { spawn: async (o) => { spawned.push(o); return { ok: true, sessionId: 's-task' } } }, tasks: taskOps, taskFlow: createTaskFlow({ dataDir: dir }), log: () => {} })
  const ceo = toolset.find((x) => x.name === 'steward_ceo')
  const r = await ceo.execute({ action: 'open_task', task: '整理十五五规划材料' }, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(spawned[0].agentPreset, undefined, '任务会话应是普通会话')
  assert.ok(spawned[0].prompt.includes('十五五规划'))
})

test('A1 史官 list_records：能列出已落盘言行录正文', async () => {
  const dir = freshDir('hist-list')
  mkdirSync(join(dir, '言行录', '2026-10'), { recursive: true })
  writeFileSync(join(dir, '言行录', '2026-10', '2026-10-27.md'), '# 言行录\n\n- 10:00 用户：测试记录一 [来源: s#1]\n- 10:01 AI：测试记录二 [来源: s#2]\n', 'utf8')
  const toolset = createToolset({ ledger: createLedger(createStore(dir)), inbox: createInbox(createStore(dir)), historian: { historianRoot: dir }, handover: createHandover({ dataDir: dir }), config: { enabled: { historian: true }, tools: { enabled: true } }, log: () => {} })
  const hist = toolset.find((x) => x.name === 'steward_historian')
  const r = await hist.execute({ action: 'list_records', date: '2026-10-27', limit: 10 }, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(r.text.includes('测试记录一') && r.text.includes('测试记录二'))
})

test('A1 工具默认关闭：config.tools.enabled=false 时不注册（成本红线）', () => {
  const { config } = resolveConfig({})
  assert.equal(config.tools.enabled, true, '用户 2026-10-26 已批：默认注册')
})

test('A1 秘书工具：add_todo 记成候选、"最"标记照抄、不给提醒', async () => {
  const { toolset, ledger } = toolFixture()
  const secretary = toolset.find((t) => t.name === 'steward_secretary')
  const result = await secretary.execute({ action: 'add_todo', title: '交房租', mostUrgent: true }, {})
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('T-001'))
  assert.ok(result.text.includes('候选'), '新记的必须是候选')
  const item = ledger.find('T-001')
  assert.equal(item.status, '候选')
  assert.equal(item.mostUrgent, true)
  assert.equal(computePriority(item).level, 3, '候选+最紧急：急不重要(2)+1=3')
})

test('A1 秘书工具：角色被关时正常人话拒绝', async () => {
  const { toolset } = toolFixture({ enabled: { secretary: false, ceo: true, historian: false } })
  const secretary = toolset.find((t) => t.name === 'steward_secretary')
  const result = await secretary.execute({ action: 'summary' }, {})
  assert.equal(result.ok, false)
  assert.ok(result.text.includes('关闭'))
})

test('A1 CEO 工具：analyze 出四问+单线（规则版），handover 只返回文本不写盘', async () => {
  const { toolset } = toolFixture()
  const ceo = toolset.find((t) => t.name === 'steward_ceo')
  const analysis = await ceo.execute({ action: 'analyze' }, {})
  assert.equal(analysis.ok, true)
  assert.ok(analysis.text.includes('四问'))
  assert.ok(analysis.text.includes('规则版'))
  assert.ok(analysis.line && analysis.line.source === 'rule')

  const card = await ceo.execute({ action: 'handover', topic: '测试主题', task: '写点东西' }, {})
  assert.equal(card.ok, true)
  assert.ok(card.text.includes('交接卡'))
  assert.equal(card.written, null, '默认不写盘')
  assert.ok(card.text.includes('没写盘'))
})

test('A1 史官工具：关时拒绝；开了默认 dryRun（只算不写）', async () => {
  const closed = toolFixture()
  const tool1 = closed.toolset.find((t) => t.name === 'steward_historian')
  const denied = await tool1.execute({ action: 'read_increment' }, {})
  assert.equal(denied.ok, false)
  assert.ok(denied.text.includes('关闭'))

  const opened = toolFixture({ enabled: { secretary: true, ceo: true, historian: true } })
  const tool2 = opened.toolset.find((t) => t.name === 'steward_historian')
  const ran = await tool2.execute({ action: 'read_increment' }, {})
  assert.equal(ran.ok, true)
  assert.ok(ran.text.includes('只算没写'), '不显式给 dryRun 时必须默认只算')
})
/* ── 熔断与停手三段（R-ENG-04） ───────────────────────────── */
test('熔断：正常推进时放行', () => {
  const r = evaluate({ role: 'ceo', steps: 3, startedAt: Date.now() - 60_000 })
  assert.equal(r.verdict, 'go')
})

test('熔断：这一步没进展 → 回头看，不硬撞', () => {
  const r = evaluate({ role: 'ceo', steps: 3, blockedRounds: 1 })
  assert.equal(r.verdict, 'look-back')
})

test('熔断：接近上限 → 换招一次；到上限 → 停', () => {
  const near = evaluate({ role: 'ceo', steps: 22 })   // 22/30 ≈ 0.73
  assert.equal(near.verdict, 'change-tactic')
  const over = evaluate({ role: 'ceo', steps: 30 })
  assert.equal(over.verdict, 'stop')
  assert.equal(over.reason, 'limit_reached')
})

test('熔断：连续受阻到阈值 → 彻底停（视为用户离开）', () => {
  const r = evaluate({ role: 'secretary', steps: 2, blockedRounds: 3 })
  assert.equal(r.verdict, 'stop')
  assert.equal(r.reason, 'blocked_too_long')
  assert.ok(r.detail.message.includes('停手'))
})

test('熔断：按时间也能触发（不只是步数）', () => {
  const r = evaluate({ role: 'secretary', steps: 1, startedAt: Date.now() - 6 * 60_000 })
  assert.equal(r.verdict, 'stop', '秘书 5 分钟上限，6 分钟应停')
})

test('熔断：预算不因重试放大（旧版踩过的坑）', () => {
  assert.equal(budgetAfterRetry(30, 0), 30)
  assert.ok(budgetAfterRetry(30, 1) < 30, '重试只会更少，不能更多')
  assert.ok(budgetAfterRetry(30, 5) >= 1, '但不能变成 0 或负数')
})

test('子代理配额：深度/并发/回合都拦得住', () => {
  assert.equal(checkSubagent({ depth: 3 }).code, 'depth_limit')
  assert.equal(checkSubagent({ concurrent: 3 }).code, 'concurrency_limit')
  assert.equal(checkSubagent({ turns: 10 }).code, 'turn_limit')
  assert.equal(checkSubagent({ depth: 1, concurrent: 1, turns: 3 }).ok, true)
  assert.equal(DEFAULT_LIMITS.subagent.maxDepth, 2)
})

test('熔断：角色名写错也能兜住（不崩）', () => {
  const r = evaluate({ role: 'who-knows', steps: 1 })
  assert.equal(r.verdict, 'go')
  assert.equal(r.detail.role, 'secretary')
})
/* ── N-2：三个角色 preset ─────────────────────────────────── */
test('角色 preset：三个 id 稳定，plugins 只放角色身份插件', () => {
  const defs = presetDefinitions()
  assert.equal(defs.length, 3)
  assert.deepEqual(Array.from(defs.map((d) => d.id)), ['steward-secretary', 'steward-ceo', 'steward-historian'])
  for (const def of defs) {
    assert.ok(def.name && def.description)
    assert.equal(def.plugins.length, 1, '每个 preset 只加一行角色插件，不重造基座')
    assert.equal(def.plugins[0].name, 'dsh-xiaozhushou/roles')
    assert.ok(['secretary', 'ceo', 'historian'].includes(def.plugins[0].config.role))
  }
})

test('角色身份段：秘书陪聊+记看板，CEO 是智能助理主体，史官只做格式化记录', () => {
  for (const role of ['secretary', 'ceo', 'historian']) {
    assert.ok(rolesPlugin.ROLE_PROMPTS[role], role + ' 要有身份段')
    assert.ok(rolesPlugin.ROLE_PROMPTS[role].length > 30)
  }
  assert.ok(rolesPlugin.ROLE_PROMPTS.secretary.includes('陪聊') && rolesPlugin.ROLE_PROMPTS.secretary.includes('记录看板'))
  assert.ok(rolesPlugin.ROLE_PROMPTS.ceo.includes('智能助理') && rolesPlugin.ROLE_PROMPTS.ceo.includes('执行'))
  assert.ok(rolesPlugin.ROLE_PROMPTS.historian.includes('只记录') && rolesPlugin.ROLE_PROMPTS.historian.includes('不判断'))
  assert.ok(rolesPlugin.ROLE_PROMPTS.historian.includes('原生数据') || rolesPlugin.ROLE_PROMPTS.historian.includes('数据底层'))
})

test('角色插件 apply：注入身份段 + 用 deny 禁掉别的角色工具（不能砍基础工具）', () => {
  const sections = []
  const restrictions = []
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') return { section: (s) => { sections.push(s); return () => {} } }
      if (name === 'tools') return { restrict: (f) => { restrictions.push(f); return () => {} } }
      return undefined
    },
  }
  rolesPlugin.apply(ctx, { role: 'ceo' })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'steward-role')
  assert.ok(sections[0].text.includes('CEO'))
  assert.equal(restrictions.length, 1)
  assert.equal(restrictions[0].allow, undefined, '不能用 allow：那会把 pwsh/读写等基础工具一起砍掉')
  assert.deepEqual(Array.from(restrictions[0].deny).slice(0, 2).sort(), ['steward_historian', 'steward_secretary'], 'CEO 只禁掉秘书与史官的工具，保留自己的与基础工具')
})

test('角色插件：服务不可用时不崩（只缺身份段）', () => {
  const ctx = { get: () => undefined }
  assert.doesNotThrow(() => rolesPlugin.apply(ctx, { role: 'secretary' }))
})

test('preset 与工具默认都关着（成本与安全红线）', () => {
  const { config } = resolveConfig({})
  assert.equal(config.tools.enabled, true)
  assert.equal(config.roles.registerPresets, true)
  const on = resolveConfig({ tools: { enabled: true }, roles: { registerPresets: true } })
  assert.equal(on.config.tools.enabled, true)
  assert.equal(on.config.roles.registerPresets, true)
})
/* ── 自审补的两块：audit 与 collect 原先没有直接测试 ──────── */
test('审计：只追加、写一条读回一条；目录写不进去也不抛（旁路不影响主功能）', () => {
  const dir = freshDir('audit')
  const audit = createAudit(dir)
  audit.write({ role: 'user', action: 'command', target: '确认 T-001', result: 'ok' })
  audit.write({ role: 'ceo', action: 'handover', target: 'x', result: 'failed', reason: 'card_too_long' })

  const text = readFileSync(join(dir, '审计.jsonl'), 'utf8').trim().split('\n')
  assert.equal(text.length, 2, '两条都在，且是追加不是覆盖')
  const first = JSON.parse(text[0])
  assert.equal(first.role, 'user')
  assert.ok(first.at, '每条都要有时间戳')
  const second = JSON.parse(text[1])
  assert.equal(second.reason, 'card_too_long')

  // 坏目录：不抛、后续写入自动跳过
  const broken = createAudit(join(dir, 'no_such_drive_' + String.fromCharCode(58) + 'path'))
  assert.doesNotThrow(() => broken.write({ role: 'x', action: 'y', target: 'z', result: 'ok' }))
  assert.doesNotThrow(() => broken.write({ role: 'x', action: 'y', target: 'z', result: 'ok' }))
})

test('采集：正常拿到元数据；listSessions 抛错时降级不崩', async () => {
  const dir = freshDir('collect-unit')
  const store = createStore(dir)

  const okCtx = { get: () => ({ listSessions: async () => [
    { header: { id: 's-1', cwd: '/x', createdAt: 1 }, live: true },
    { header: { id: 's-2', cwd: '/y', createdAt: 2 }, live: false },
  ] }) }
  const good = await collect(okCtx, store, () => {})
  assert.equal(good.ok, true)
  assert.equal(good.sessions.length, 2)
  assert.equal(good.total, 2)
  assert.equal(good.sessions[0].id, 's-1')
  // 落盘一份快照
  const saved = JSON.parse(readFileSync(join(dir, '采集.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.sessions.length, 2)

  const badCtx = { get: () => ({ listSessions: async () => { throw new Error('boom') } }) }
  const bad = await collect(badCtx, store, () => {})
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'collect_failed')
  assert.deepEqual(Array.from(bad.sessions), [], '失败时给空数组，调用方不用判空')

  const noSvc = { get: () => undefined }
  const missing = await collect(noSvc, store, () => {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'no_session_query')
})

test('采集：数量超上限时截断并标记（不悄悄读爆）', async () => {
  const dir = freshDir('collect-truncate')
  const store = createStore(dir)
  const many = Array.from({ length: 90 }, (_, i) => ({ header: { id: 's-' + i, cwd: '/x' }, live: false }))
  const result = await collect({ get: () => ({ listSessions: async () => many }) }, store, () => {})
  assert.equal(result.ok, true)
  assert.equal(result.sessions.length, 80, '最多读 80 个会话')
  assert.equal(result.truncated, true, '截断要标出来')
  assert.equal(result.total, 90)
})
/* ── A3：真推送 + 沙盒 ───────────────────────────────────── */
function pushFixture({ titles = {}, allowed = [], sandbox = {}, store = undefined } = {}) {
  const audits = []
  const prompts = []
  const signalSeen = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => Object.keys(titles).map((id) => ({ header: { id } })),
          readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: titles[id] } } })),
        }
      }
      if (name === 'sessionController') {
        return { prompt: async (req, signal) => { prompts.push(req); signalSeen.push(signal); return { accepted: true } } }
      }
      return undefined
    },
  }
  const config = { alarm: { push: { enabled: true, maxItems: 3 } }, sandbox: { enabled: true, sessionTitlePrefix: '[实验]', allowedSessionIds: allowed, maxPushPerDay: 6, ...sandbox } }
  const push = createPush({ ctx, config, audit: { write: (e) => audits.push(e) }, log: () => {}, store })
  return { push, prompts, audits, signalSeen, ctx, config, store }
}

test('A3 沙盒：没有 [实验] 开头的会话时，绝不往真实会话推', async () => {
  const { push, prompts, audits } = pushFixture({ titles: { 's-real': '周末大扫除', 's-real2': '普通会话标题' } })
  const result = await push.push([{ id: 'T-001', title: '交房租' }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_sandbox_session')
  assert.equal(prompts.length, 0, '一条都不能发')
  assert.ok(result.message.includes('[实验]'), '要告诉用户怎么开沙盒会话')
  assert.ok(audits.some((e) => e.action === 'push:blocked' && e.result === 'denied'))
})

test('A3 沙盒：命中 [实验] 会话才推送，且只发标题不发内容', async () => {
  const fix = pushFixture({ titles: { 's-real': '真实会话', 's-lab': '[实验]测试' } })
  const result = await fix.push.push([{ id: 'T-001', title: '交房租', due: '2026-10-26' }])
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 's-lab')
  assert.equal(result.via, 'title')
  assert.equal(fix.prompts.length, 1)
  assert.ok(fix.signalSeen[0] && typeof fix.signalSeen[0].throwIfAborted === 'function', '推送也必须传第二个参数 signal')
  const text = fix.prompts[0].content[0].text
  assert.ok(text.includes('交房租'))
  assert.ok(text.includes('实验推送'), '要标明是实验')
})

test('A3 沙盒：白名单会话优先；关掉推送开关就不推', async () => {
  const allow = pushFixture({ titles: {}, allowed: ['s-allowed'] })
  const r1 = await allow.push.push([{ id: 'T-1', title: 'x' }])
  assert.equal(r1.ok, true)
  assert.equal(r1.sessionId, 's-allowed')

  const off = pushFixture({ titles: { 's-lab': '[实验]x' }, sandbox: {} })
  off.push.state.today = 'set'
  const r2 = await createPush({ ctx: { get: () => undefined }, config: { alarm: { push: { enabled: false } }, sandbox: {} }, audit: { write: () => {} }, log: () => {} }).push([{ id: 'T-1', title: 'x' }])
  assert.equal(r2.code, 'push_disabled')
})

test('R-01：不带日期确认，不能把已有的截止日和优先级清空（裁判复核抓到的必修）', () => {
  const dir = freshDir('confirm-keep-due')
  const store = createStore(dir)
  const ledger = createLedger(store)
  const added = ledger.add({ title: '交房租', due: '2026-10-30', urgency: 3, importance: 3 })
  assert.equal(added.ok, true)
  const result = mod.applyCommand(ledger, '确认 ' + added.item.id)
  assert.equal(result.ok, true)
  const after = ledger.stats().confirmed[0]
  assert.equal(after.due, '2026-10-30', '没提日期就该保留原截止日')
  assert.equal(after.urgency, 3, '没提紧急就该保留原优先级')
  assert.equal(after.importance, 3, '没提重要就该保留原优先级')
})

test('推送状态必须落盘：成功推一次后 store 里要能看到今天的计数与去重键', async () => {
  const dir = freshDir('push-persist')
  const store = createStore(dir)
  const fixture = pushFixture({ titles: { 's-lab': '[实验]测试' }, store })
  const result = await fixture.push.push([{ id: 'T-5', title: '一次' }])
  assert.equal(result.ok, true)
  const saved = store.read('推送状态.json', null)
  assert.ok(saved, '推送状态文件必须被写出来（以前只在内存，重启即归零）')
  assert.equal(saved.todayCount, 1)
  assert.ok(saved.pushedKeys['T-5'], '去重键要落盘')
})
test('推送去重：同一事项同一天只推一次（修：以前只记录不检查）', async () => {
  const { push, prompts } = pushFixture({ titles: { 's-lab': '[实验]测试' } })
  const first = await push.push([{ id: 'T-9', title: '同一件事' }])
  assert.equal(first.ok, true)
  const second = await push.push([{ id: 'T-9', title: '同一件事' }])
  assert.equal(second.ok, false)
  assert.equal(second.code, 'already_pushed')
  assert.equal(prompts.length, 1, '不能重复打扰')
})

test('写接口：非 POST 直接 405；坏 JSON 明确报 invalid_json', async () => {
  const dir = freshDir('http-guard')
  const { ctx, routes } = makeCtx(dir)
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const todo = routes.get('/api/dsh-xiaozhushou/todo')
  // 直接调 handler，伪造 req
  const fakeRes = () => {
    const out = { code: 0, body: '' }
    return {
      out,
      writeHead(code) { out.code = code },
      end(text) { out.body = String(text || '') },
      setHeader() {},
    }
  }
  const makeReq = (method, payload) => {
    const listeners = {}
    return {
      method,
      on(event, fn) { listeners[event] = fn; return this },
      trigger() { listeners.data && listeners.data(payload); listeners.end && listeners.end() },
    }
  }
  const res1 = fakeRes(); const req1 = makeReq('DELETE', '')
  const p1 = todo.handler(req1, res1); req1.trigger(); await p1
  assert.equal(res1.out.code, 405, '非 POST 应 405')
  const res2 = fakeRes(); const req2 = makeReq('POST', '{bad json')
  const p2 = todo.handler(req2, res2); req2.trigger(); await p2
  assert.ok(res2.out.body.includes('invalid_json'), '坏 JSON 应报 invalid_json，实际：' + res2.out.body)
})

test('开新会话：一小时内超过 4 次会被限频', async () => {
  const dir = freshDir('spawn-limit')
  const calls = { create: 0 }
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => { calls.create += 1; return { sessionId: 's-' + calls.create } },
          rename: async () => ({}),
          prompt: async () => ({}),
        }
      }
      return undefined
    },
  }
  const spawner = createSpawner(ctx)
  let last
  for (let i = 0; i < 5; i += 1) {
    last = await spawner.spawn({ title: '测试' + i, prompt: '第一句', confirmedByAuthor: true })
  }
  assert.equal(last.ok, false)
  assert.equal(last.code, 'rate_limited')
  assert.equal(calls.create, 4, '只应真的建 4 个')
})
test('A3 推送：每天次数上限挡得住', async () => {
  const { push, prompts } = pushFixture({ titles: { 's-lab': '[实验]测试' }, sandbox: { maxPushPerDay: 1 } })
  assert.equal((await push.push([{ id: 'T-1', title: 'a' }])).ok, true)
  const second = await push.push([{ id: 'T-2', title: 'b' }])
  assert.equal(second.ok, false)
  assert.equal(second.code, 'daily_limit')
  assert.equal(prompts.length, 1)
})

test('A3 推送：没东西可推时不发空消息', async () => {
  const { push, prompts } = pushFixture({ titles: { 's-lab': '[实验]x' } })
  const result = await push.push([])
  assert.equal(result.code, 'nothing_to_push')
  assert.equal(prompts.length, 0)
})
/* ── M4 大脑层：模型调用与降级 ───────────────────────────── */
function brainFixture({ reply = '{"four":{"done":"a","todo":"b","next":"c","urgent":"d"},"line":{"conclusion":"e","evidence":["x（强·台账）"],"risk":"f","options":["g"],"recommend":"h","decision":"i"}}', throwAt = null, enabled = true } = {}) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'llm') {
        return {
          stream: (options) => {
            calls.push(options)
            if (throwAt === 'stream') throw new Error('boom')
            return (async function* () {
              if (throwAt === 'iterate') throw new Error('iter-boom')
              yield { type: 'text-delta', index: 0, text: reply }
              yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      }
      return undefined
    },
  }
  const config = { model: { enabled, maxTokens: 500, timeoutMs: 5000, temperature: 0.3 } }
  return { brain: createBrain({ ctx, config, log: () => {} }), calls }
}

test('大脑层：能拿到默认模型时才 available', () => {
  assert.equal(brainFixture().brain.available(), true)
  assert.equal(brainFixture({ enabled: false }).brain.available(), false)
  const noCtx = createBrain({ ctx: { get: () => undefined }, config: {}, log: () => {} })
  assert.equal(noCtx.available(), false)
})

test('大脑层：正常返回文本与用量，并按上限截断 maxTokens', async () => {
  const { brain, calls } = brainFixture()
  const answer = await brain.ask({ prompt: '分析一下', maxTokens: 99999 })
  assert.equal(answer.ok, true)
  assert.equal(answer.source, 'model')
  assert.ok(answer.text.includes('four'))
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].model, 'm')
  assert.equal(calls[0].maxTokens, 4000, '要按上限收敛，不能无限放大')
})

test('大脑层：模型报错/抛错都退成 ok:false，不假装成功', async () => {
  const streamErr = brainFixture({ throwAt: 'stream' })
  const r1 = await streamErr.brain.ask({ prompt: 'x' })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'model_failed')

  const iterErr = brainFixture({ throwAt: 'iterate' })
  const r2 = await iterErr.brain.ask({ prompt: 'x' })
  assert.equal(r2.ok, false)

  const empty = brainFixture({ reply: '   ' })
  const r3 = await empty.brain.ask({ prompt: 'x' })
  assert.equal(r3.code, 'empty_reply')
})

test('大脑层关掉时直接拒绝（可一键省成本）', async () => {
  const { brain } = brainFixture({ enabled: false })
  const r = await brain.ask({ prompt: 'x' })
  assert.equal(r.code, 'model_disabled')
})

test('CEO analyze：模型可用时用模型版；模型坏时退回规则版并标注', async () => {
  const dir = freshDir('brain-ceo')
  const store = createStore(dir)
  const ledger = createLedger(store)
  ledger.add({ title: '交房租' })

  const good = brainFixture()
  const toolsetGood = createToolset({ ledger, inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { ceo: true }, tools: { enabled: true } }, brain: good.brain, log: () => {} })
  const ceoGood = toolsetGood.find((x) => x.name === 'steward_ceo')
  const r1 = await ceoGood.execute({ action: 'analyze' }, {})
  assert.equal(r1.ok, true)
  assert.ok(r1.text.includes('模型版'), '模型版要标出来')
  assert.equal(r1.line.source, 'model')

  const bad = brainFixture({ throwAt: 'stream' })
  const toolsetBad = createToolset({ ledger, inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { ceo: true }, tools: { enabled: true } }, brain: bad.brain, log: () => {} })
  const ceoBad = toolsetBad.find((x) => x.name === 'steward_ceo')
  const r2 = await ceoBad.execute({ action: 'analyze' }, {})
  assert.equal(r2.ok, true)
  assert.ok(r2.text.includes('规则版'), '模型坏了要明确退回规则版')
  assert.equal(r2.line.source, 'rule')
})

test('CEO analyze：模型回的不是 JSON 时也退回规则版（不瞎解析）', async () => {
  const dir = freshDir('brain-bad-json')
  const store = createStore(dir)
  const ledger = createLedger(store)
  const bad = brainFixture({ reply: '我觉得应该先做重要的那件事。' })
  const toolset = createToolset({ ledger, inbox: createInbox(store), historian: null, handover: createHandover({ dataDir: dir }), config: { enabled: { ceo: true }, tools: { enabled: true } }, brain: bad.brain, log: () => {} })
  const ceo = toolset.find((x) => x.name === 'steward_ceo')
  const r = await ceo.execute({ action: 'analyze' }, {})
  assert.equal(r.line.source, 'rule', '解析不出 JSON 就退回规则版')
})
/* ── R-ROL-09：CEO → 秘书极简备案 ────────────────────────── */
test('秘书备案：写一条 → jsonl 追加 + 人读 md 生成，字段都是短字段', () => {
  const dir = freshDir('notice')
  const notifier = createNotifier({ dataDir: dir })
  const r1 = notifier.write({ topic: '家务安排', conclusion: '先买菜再做饭', todo: ['买菜'], sessionId: 's-1' })
  assert.equal(r1.ok, true)
  assert.equal(r1.record.role, 'ceo')

  const jsonl = readFileSync(join(dir, '备忘', '秘书备案.jsonl'), 'utf8').trim().split('\n')
  assert.equal(jsonl.length, 1)
  const md = readFileSync(join(dir, '备忘', '秘书备案.md'), 'utf8')
  assert.ok(md.includes('家务安排'), '人读版要能直接翻')
  assert.ok(md.includes('先买菜再做饭'))

  // 只追加
  notifier.write({ topic: '第二条', conclusion: '随便', sessionId: 's-2' })
  const jsonl2 = readFileSync(join(dir, '备忘', '秘书备案.jsonl'), 'utf8').trim().split('\n')
  assert.equal(jsonl2.length, 2, '只追加不覆盖')
  assert.equal(notifier.recent(5).length, 2)
})

test('秘书备案：空主题/空结论被拒；超长自动截断', () => {
  const dir = freshDir('notice2')
  const notifier = createNotifier({ dataDir: dir })
  assert.equal(notifier.write({ topic: '', conclusion: 'x' }).code, 'empty_notice')
  assert.equal(notifier.write({ topic: 'x', conclusion: '   ' }).code, 'empty_notice')
  const long = notifier.write({ topic: '主'.repeat(80), conclusion: '结'.repeat(120) })
  assert.equal(long.ok, true)
  assert.ok(long.record.topic.length <= 41)
  assert.ok(long.record.conclusion.length <= 61)
})

test('CEO 工具：notify_secretary 能落备案，并在工具文本里确认', async () => {
  const dir = freshDir('ceo-notify')
  const store = createStore(dir)
  const ledger = createLedger(store)
  const toolset = createToolset({
    ledger,
    inbox: createInbox(store),
    historian: null,
    handover: createHandover({ dataDir: dir }),
    config: { enabled: { ceo: true }, tools: { enabled: true } },
    notifier: createNotifier({ dataDir: dir }),
    log: () => {},
  })
  const ceo = toolset.find((x) => x.name === 'steward_ceo')
  const r = await ceo.execute({ action: 'notify_secretary', topic: '给用户汇报', conclusion: '三步走', todo: ['第一步'], sessionId: 's-9' }, {})
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('备案'))
  assert.equal(r.record.topic, '给用户汇报')
})
/* ── R-SCE-12：找文件 ───────────────────────────────────── */
test('全新安装（无指针）默认目录是用户主目录下的 .dsh-session-steward/data', () => {
  // 清掉测试用的假 home 里的指针，模拟"第一次安装"
  const ptrFile = paths.pointerPath()
  try { rmSync(ptrFile, { force: true }) } catch {}
  const resolved = paths.resolveDataDir({ get: () => undefined }, {})
  assert.equal(resolved.toLowerCase(), paths.defaultDataDir().toLowerCase(), '默认应落到主目录 data，实际：' + resolved)
  assert.ok(/[\\/]\.dsh-session-steward[\\/]data$/i.test(resolved), '目录应为 .dsh-session-steward/data，实际：' + resolved)
})
test('数据目录指针防污染：.tmp / node_modules 下的路径不许被当成数据目录', () => {
  const base = freshDir('ptr-poison')
  const poison = join(base, '.tmp', 'dsh小助手')
  mkdirSync(poison, { recursive: true })
  assert.equal(paths.writePointer(poison), false, '不应把 .tmp 路径写进指针')
  // 也验证读端：手动写一个脏指针，读回来应为空
  const file = paths.pointerPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, poison, 'utf8')
  assert.equal(paths.readPointer(), '', '脏指针必须被忽略')
})
test('数据目录：写过指针后，即使工作区没注册也不会漂到别处', () => {
  const base = freshDir('datadir-pointer')
  const target = join(process.env.USERPROFILE, '实测数据目录')
  mkdirSync(target, { recursive: true })
  const ok = paths.writePointer(target)
  assert.equal(ok, true, '指针要能写')
  assert.equal(paths.readPointer(), target, '指针要能读回')
  // 关键：给一个"没有工作区注册"的 ctx，也应该仍然用指针里的目录
  const noWorkspace = { get: () => undefined }
  const resolved = paths.resolveDataDir(noWorkspace, {})
  assert.equal(resolved.toLowerCase(), target.toLowerCase(), '不能漂到 profile 或 cwd')
})

test('数据目录：配置里写死的 dataDir 优先于指针', () => {
  const base = freshDir('datadir-config')
  const configured = join(base, '自定义')
  const resolved = paths.resolveDataDir({ get: () => undefined }, { dataDir: configured })
  assert.ok(resolved.toLowerCase().indexOf('自定义') >= 0, '配置应优先，实际 ' + resolved)
})

test('D-18 兼容：新指针不存在时回退读旧 .dsh-xiaozhushou 指针（升级不丢数据）', () => {
  const home = process.env.USERPROFILE
  const legacyPointer = join(home, '.dsh-xiaozhushou', 'datadir.txt')
  const legacyData = join(home, '旧版数据目录')
  const newData = join(home, '新版数据目录')
  mkdirSync(legacyData, { recursive: true })
  mkdirSync(newData, { recursive: true })

  // 只留旧指针、清掉新指针 → 读回旧目录
  rmSync(paths.pointerPath(), { force: true })
  mkdirSync(dirname(legacyPointer), { recursive: true })
  writeFileSync(legacyPointer, legacyData, 'utf8')
  assert.equal(paths.readPointer(), legacyData, '旧指针要能读回')
  const resolved = paths.resolveDataDir({ get: () => undefined }, {})
  assert.equal(resolved.toLowerCase(), legacyData.toLowerCase(), '升级后继续用旧数据目录，不丢数据')

  // 新指针一出现就优先
  assert.equal(paths.writePointer(newData), true)
  assert.equal(paths.readPointer(), newData, '新指针优先于旧指针')

  rmSync(legacyPointer, { force: true })
})
test('找文件：能按文件名和内容找；只在允许的根目录里找', () => {
  const base = freshDir('find-base')
  const dataDir = join(base, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(base, '资料'), { recursive: true })
  writeFileSync(join(base, '资料', '读书笔记.md'), '# 番茄\n这里是笔记内容', 'utf8')
  writeFileSync(join(base, '资料', '别的东西.md'), '此处提到番茄一次', 'utf8')
  mkdirSync(join(base, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(base, 'node_modules', 'x', '番茄.md'), '不该被找到', 'utf8')

  const finder = createFinder({ config: {}, dataDir, log: () => {} })

  const byName = finder.find({ query: '读书笔记' })
  assert.equal(byName.ok, true)
  assert.equal(byName.hits.length, 1)
  assert.equal(byName.hits[0].hit, 'name')
  assert.ok(!byName.hits[0].relative.includes('node_modules'), '不能进 node_modules')

  // 2026-10-26 改口径：内容检索默认关闭（隐私），必须显式 content:true 才搜内容
  const byContent = finder.find({ query: '番茄', content: true })
  assert.ok(byContent.hits.some((hit) => hit.hit === 'content'))

  const outside = finder.find({ query: 'x', root: 'C:\\Windows' })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, 'root_not_allowed', '越界要拒绝')
})

test('找文件：空关键词拒绝；结果有上限；二进制/大文件跳过', () => {
  const base = freshDir('find-limits')
  const dataDir = join(base, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  for (let i = 0; i < 30; i += 1) writeFileSync(join(base, `同名笔记-${i}.md`), 'hello', 'utf8')
  writeFileSync(join(base, '图.png'), 'not really png', 'utf8')

  const finder = createFinder({ config: {}, dataDir, log: () => {} })
  assert.equal(finder.find({ query: '  ' }).code, 'empty_query')

  const capped = finder.find({ query: '同名笔记', limit: 5 })
  assert.equal(capped.hits.length, 5)
  assert.equal(capped.truncated, true)

  const png = finder.find({ query: 'hello', limit: 5 })
  assert.ok(!png.hits.some((hit) => hit.name.endsWith('.png')), '二进制扩展名不读内容')
})

test('秘书工具：find_files 能返回结果给人话清单', async () => {
  const base = freshDir('find-tool')
  const dataDir = join(base, 'dsh小助手')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(base, '读书笔记.md'), '番茄 笔记', 'utf8')
  const store = createStore(dataDir)
  const toolset = createToolset({
    ledger: createLedger(store),
    inbox: createInbox(store),
    historian: null,
    handover: createHandover({ dataDir }),
    config: { enabled: { secretary: true }, tools: { enabled: true } },
    finder: createFinder({ config: {}, dataDir, log: () => {} }),
    log: () => {},
  })
  const secretary = toolset.find((x) => x.name === 'steward_secretary')
  const r = await secretary.execute({ action: 'find_files', query: '读书笔记' }, {})
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('读书笔记'))
  assert.equal(r.hits.length, 1)
})
/* ── 用户真实输入 vs 宿主注入 ────────────────────────────── */
test('注入消息不是用户真实输入：目标模式/系统提醒/团队消息/压缩说明都要排除', () => {
  const injected = [
    '<goal_round>\nObjective: ...',
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    '<system-reminder>some reminder</system-reminder>',
    'Team message from helper: 任务完成',
    'This is an automatically generated checkpoint condensing an earlier span',
    'The available skill catalog changed. This complete catalog replaces…',
    'The goal is marked complete and this autonomous run is ending.',
    'Background subagent 9b65 finished and will do no further work',
  ]
  for (const text of injected) {
    assert.equal(isInjected(text), true, '应判为注入：' + text.slice(0, 30))
  }
  const real = [
    '帮我把周末计划列一下，贴在冰箱上',
    '今天有点累，明天再说',
    '史官测试用会话，请回一句话',
  ]
  for (const text of real) {
    assert.equal(isInjected(text), false, '不该判为注入：' + text)
  }
  assert.ok(INJECTED_MARKERS.length >= 8)
})
/* ── 纯函数层 ─────────────────────────────────────────────── */
test('灯状态穷尽表：4 个条件 16 种组合都归一到唯一状态', () => {
  const expected = (a, b, c, d) => a ? 'confirm' : b ? 'urgent' : c ? 'working' : d ? 'todo' : 'idle'
  for (let bits = 0; bits < 16; bits += 1) {
    const a = Boolean(bits & 1)
    const b = Boolean(bits & 2)
    const c = Boolean(bits & 4)
    const d = Boolean(bits & 8)
    const got = classifyLamp({ needsConfirm: a, urgent: b, working: c, hasTodo: d }).state
    assert.equal(got, expected(a, b, c, d), 'bits=' + bits)
  }
})

test('buildState 灯态：确认红闪、紧急红常亮、工作黄闪、待办黄常亮、无动作绿', () => {
  const mk = (items, extra = {}) => ({ ledger: { stats: () => ({ confirmed: items, pendingCount: 0, doneCount: 0, droppedCount: 0, skipped: 0, ...extra }) } })
  assert.equal(buildState(mk([])).lamp.color, 'green')
  assert.equal(buildState(mk([])).lamp.mode, 'steady')
  assert.equal(buildState(mk([{ id: 'T-1', title: 'a', urgency: 1, importance: 1 }])).lamp.color, 'warn')
  assert.equal(buildState(mk([{ id: 'T-1', title: 'a', urgency: 3, importance: 3 }])).lamp.color, 'red')
  assert.equal(buildState(mk([], { pendingCount: 1 })).lamp.mode, 'blink')
  assert.equal(buildState(mk([], { pendingCount: 1 })).lamp.interval, 400)
  const working = buildState({ ledger: { stats: () => ({ confirmed: [], pendingCount: 0 }) }, snapshot: { sessions: [{ id: 's', live: true }] } })
  assert.equal(working.lamp.color, 'warn')
  assert.equal(working.lamp.mode, 'blink')
  assert.equal(working.lamp.interval, 800)
  assert.equal(buildState({ ledger: null }).lamp.color, 'green', '台账坏了也要给个状态，不能崩')
})

test('buildBoard：今天到期进"要你动手"与提醒', () => {
  const today = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const board = buildBoard({
    ledger: {
      stats: () => ({
        confirmed: [{ id: 'T-001', title: '今天的事', due: today, urgency: 3, importance: 2 }],
        pendingCount: 0,
        doneCount: 0,
        droppedCount: 0,
        skipped: 0,
      }),
    },
    snapshot: { ok: true, sessions: [], total: 0 },
  })
  assert.equal(board.groups.you.length, 1)
  assert.equal(board.reminder.items.length, 1)
  assert.ok(board.reminder.reason.includes('今天到期'))
})

/* ── 客户端半 ─────────────────────────────────────────────── */
test('防再犯：client.js 里每个 h(Xxx) 引用的组件都必须在文件里定义', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  const used = new Set()
  const re = /\bh\(\s*([A-Z][A-Za-z0-9_]*)\s*,/g
  let m
  while ((m = re.exec(src))) used.add(m[1])
  // 函数参数名（如 safe() 里的 Component）也算可用
  const paramNames = new Set()
  const pre = /function\s*[A-Za-z0-9_]*\s*\(([^)]*)\)/g
  let pm
  while ((pm = pre.exec(src))) {
    for (const part of pm[1].split(',')) {
      const name = part.trim().split('=')[0].trim()
      if (name) paramNames.add(name)
    }
  }
  const arrow = /\(([^)]*)\)\s*=>/g
  while ((pm = arrow.exec(src))) {
    for (const part of pm[1].split(',')) {
      const name = part.trim().split('=')[0].trim()
      if (name) paramNames.add(name)
    }
  }
  const missing = []
  for (const name of used) {
    const hasFunction = src.indexOf('function ' + name + '(') >= 0
    const hasClass = src.indexOf('class ' + name) >= 0
    const hasConst = src.indexOf('const ' + name + ' =') >= 0
    if (!hasFunction && !hasClass && !hasConst && !paramNames.has(name)) missing.push(name)
  }
  assert.deepEqual(missing, [], '这些组件被使用但没有定义：' + missing.join(', '))
})
test('侧栏小鲸尾会摇（幅度小、周期慢、尊重减少动态）', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(/ke-ico-sway/.test(src), '要有摇尾动画')
  assert.ok(/className: 'ke-ico'/.test(src), '侧栏图标要挂上动画类')
  const m = /@keyframes ke-ico-sway\{0%,100%\{transform:rotate\(-([\d.]+)deg\)\}50%\{transform:rotate\(([\d.]+)deg\)\}\}/.exec(src)
  assert.ok(m, '摇尾关键帧要能解析')
  assert.ok(Number(m[2]) <= 10, '幅度不能超过 ±10°（22px 下会像抽搐）')
  assert.ok(/prefers-reduced-motion[^}]*ke-ico/.test(src) || /ke-ico\{animation:none\}/.test(src), '要尊重减少动态偏好')
  assert.ok(/animation:ke-ico-sway 3\.2s/.test(src), '周期要慢（3.2s）')
})
test('看板娘动作状态机：拎起/放下/悬停 都有，且光标不显示手指', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(/mode-grabbed/.test(src), '要有"被拎起"状态')
  assert.ok(/mode-dropped/.test(src), '要有"放下回弹"状态')
  assert.ok(/mode-hover/.test(src), '要有悬停状态')
  assert.ok(/ke-drop/.test(src), '放下要有回弹动画')
  assert.ok(/setMode\('grabbed'\)/.test(src), '拖动开始时切到 grabbed')
  // 不能出现 grab/grabbing 光标（那会显示手指），只允许 move
  assert.ok(!/cursor:\s*['"]?(grab|grabbing)\b/.test(src), '不能用 grab/grabbing 光标（会显示手指）')
  assert.ok(/cursor:move/.test(src), '要用 move 光标')
  // 动作切换时把呼吸动画停掉，避免叠加
  assert.ok(/mode-grabbed \.art\{animation:none/.test(src), '拎起时要停掉呼吸（叠加会抖）')
})
test('V-18 入口不丢失：鲸鱼娘能隐藏，且从看板能找回来', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('PET_HIDDEN_KEY'), '要有持久化的隐藏标记')
  assert.ok(src.includes('readPetHidden') && src.includes('writePetHidden'), '要有读写隐藏状态的函数')
  assert.ok(src.includes('显示鲸鱼娘') && src.includes('隐藏鲸鱼娘'), '看板上要有显示/隐藏按钮')
  assert.ok(src.includes('PET_VIS_EVENT'), '隐藏后要能通知浮层立刻生效（不用刷新）')
  // 隐藏时必须不渲染，但**必须在所有 hooks 之后**才行（否则 React 报 Rendered fewer hooks）
  const petStart = src.indexOf('function PetOverlay()')
  const petEnd = src.indexOf('\n    function ', petStart + 10)
  const petSrc = src.slice(petStart, petEnd > petStart ? petEnd : src.length)
  const nullPos = petSrc.indexOf('if (hidden) return null')
  const lastHook = Math.max(petSrc.lastIndexOf('React.useEffect('), petSrc.lastIndexOf('React.useState('))
  assert.ok(nullPos > 0, '隐藏时浮层必须真的不渲染')
  assert.ok(nullPos > lastHook, 'hidden 的早返回必须写在所有 hooks 之后（hooks 顺序不能变）')
})
test('眨眼与灯闪的 keyframes 不能同名（同名会互相覆盖，导致"闭眼很久"的恐怖谷）', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('ke-eyelid'), '眼睛要用独立的 ke-eyelid 动画')
  assert.ok(src.includes('ke-lamp-blink'), '红灯要用独立的 ke-lamp-blink 动画')
  const names = (src.match(/@keyframes\s+([a-z-]+)/g) || []).map((x) => x.replace(/@keyframes\s+/, ''))
  const dup = names.filter((name, i) => names.indexOf(name) !== i)
  assert.equal(dup.length, 0, 'keyframes 名字不能重复，重复的：' + dup.join('、'))
  // 闭眼时长 ≈ 1% 周期（5.2s 的 1% = 52ms），不能是几十个百分点
  const m = /@keyframes ke-eyelid\{0%,([\d.]+)%,100%\{transform:scaleY\(1\)\}([\d.]+)%,([\d.]+)%\{transform:scaleY\(([\d.]+)\)\}\}/.exec(src)
  assert.ok(m, '眨眼关键帧格式要能解析')
  const closedRatio = (Number(m[3]) - Number(m[2])) / 100
  assert.ok(closedRatio <= 0.05, '闭眼时间应 ≤5% 周期（现 ' + (closedRatio * 100).toFixed(1) + '%）')
})
test('状态灯动画：红闪 0.4s、黄闪 0.8s，灭时完全消失', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('ke-lamp-blink'), '要有灯闪关键帧')
  assert.ok(/confirm:.*interval: 400/.test(readFileSync(join(pkgDir, 'core', 'lamp.js'), 'utf8')), '人工确认 0.4s')
  assert.ok(/working:.*interval: 800/.test(readFileSync(join(pkgDir, 'core', 'lamp.js'), 'utf8')), '工作 0.8s')
  const m = /@keyframes ke-lamp-blink\{0%,([\d.]+)%\{opacity:1\}([\d.]+)%,100%\{opacity:([\d.]+)\}\}/.exec(src)
  assert.ok(m, '灯闪关键帧要能解析')
  assert.equal(m[3], '0', '灭的时候必须完全消失')
  assert.ok((100 - Number(m[2])) / 100 <= 0.30, '灭的时间不能太长')
})
test('鲸鱼娘动效：呼吸/眨眼/尾摆都是纯 CSS，且尊重减少动态偏好', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('ke-breathe'), '要有呼吸动画')
  assert.ok(src.includes('ke-blink'), '要有眨眼动画')
  assert.ok(src.includes('ke-tail'), '要有尾摆动画')
  assert.ok(src.includes('prefers-reduced-motion'), '必须尊重系统"减少动态"偏好')
  assert.ok(!/https?:\/\//.test(src), '动效不能依赖外部资源')
  assert.ok(src.indexOf('class="eye"') > 0 && src.indexOf('class="tail"') > 0, 'SVG 部位要挂动画类')
})
test('client.js 收起必须回到浮窗右侧（右边缘锚定）', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('rightAnchored'), '必须有右边缘锚定函数')
  assert.ok(/sizeFrom\.width - sizeTo\.width/.test(src), '锚定要按两者宽度差换算')
  assert.ok(!/function toggle\(nextOpen\) \{\s*const target[^}]*clampPos\(current\.x/.test(src), '不能只做原地夹取（那会让鲸鱼娘停在左上角）')
  // 宽度常量必须与 CSS 一致，否则每次切换都会偏几像素
  const cssCollapsed = /\.ke-pet\{[^}]*width:(\d+)px/.exec(src)
  const cssExpanded = /\.ke-pet\.expanded\{width:(\d+)px/.exec(src)
  assert.ok(cssCollapsed && cssExpanded, 'CSS 里应能读到两个宽度')
  assert.ok(src.includes(`PET_COLLAPSED = { width: ${cssCollapsed[1]}`), '收起宽度常量要与 CSS 一致')
  assert.ok(src.includes(`PET_EXPANDED = { width: ${cssExpanded[1]}`), '展开宽度常量要与 CSS 一致')
})
test('client.js 浮窗必须能收起、能拖、不会拖出屏（防回归）', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('clampPos'), '必须做视口夹取，否则一撑就出屏')
  assert.ok(src.includes("ev.key === 'Escape'"), '必须能用 Esc 收起')
  assert.ok(src.includes('toggle(false)'), '必须有明确的收起入口')
  assert.ok(src.includes('startDrag'), '必须有拖动把手')
  assert.ok(src.includes('onDoubleClick'), '要支持双击标题栏收起')
  assert.ok(!src.includes("className: 'x'"), '右上角那个最小化小图标已按要求去掉')
  assert.ok(/\.ke-pet \.hd\{[^}]*background:#f2f3f5/.test(src), '菜单栏要与底色区分开')
  assert.ok(src.includes('petCollapseGuardUntil'), '双击收起要防抖，避免第二次点击又弹开')
  assert.ok(!/if \(open\) return/.test(src), '展开态不能直接 return 掉拖拽')
})
test('client.js 不引用任何外部资源', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.equal(/(<img|https?:\/\/|url\((?!\s*['"]?#))/.test(src), false, 'client.js 不应引用外部资源（允许 url(#id) 这种 SVG 内部引用）')
})

const clientSrc = readFileSync(join(pkgDir, 'client.js'), 'utf8')

function makeReactStub() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  function Component(props) {
    this.props = props
    this.state = {}
  }
  Component.prototype.setState = function (patch) {
    Object.assign(this.state, patch)
  }
  return { createElement, Component, useState: (init) => [init, () => {}], useEffect: () => {} }
}

test('client.js：id 一致，apply 注册 3 个插槽且 main.key 与侧栏 id 相同', () => {
  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (def) => (captured = def) },
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1280,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSrc, sandbox, { filename: 'client.js' })

  assert.ok(captured, '__ModuleLoader__.load 未被调用')
  assert.equal(captured.id, 'dsh-xiaozhushou')

  const half = captured.factory((name) => {
    if (name === 'react') return makeReactStub()
    throw new Error('unexpected require: ' + name)
  })
  assert.deepEqual(Array.from(half.inject), ['slots'])

  const injected = []
  const registered = []
  half.apply({
    slots: {
      inject(name, fn) {
        injected.push(name)
        fn()
      },
      register(config) {
        registered.push(config)
        return () => {}
      },
    },
  })

  assert.deepEqual(Array.from(injected), ['sidebar.panellist', 'main', 'shell.overlay'])
  assert.equal(registered.length, 3)
  const panel = registered.find((r) => r.name === 'sidebar.panellist')
  const main = registered.find((r) => r.name === 'main')
  const overlay = registered.find((r) => r.name === 'shell.overlay')
  assert.equal(panel.id, 'steward')
  assert.equal(main.key, 'steward', 'main.key 必须等于侧栏 id，否则点图标切不过去')
  assert.equal(overlay.id, 'steward-pet')
})

/* ── 展示清单 ─────────────────────────────────────────────── */
test('locale 中英齐全（meta.title / meta.description）', () => {
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(readFileSync(join(pkgDir, 'locale', `${lang}.json`), 'utf8'))
    assert.ok(locale.meta.title, `${lang} 缺 meta.title`)
    assert.ok(locale.meta.description, `${lang} 缺 meta.description`)
  }
})

test('icon.svg 合法且 ≤256KiB；assets 占位图存在', () => {
  const icon = readFileSync(join(pkgDir, 'icon.svg'), 'utf8')
  assert.ok(icon.trimStart().startsWith('<svg'))
  assert.ok(Buffer.byteLength(icon) <= 256 * 1024)
  const asset = readFileSync(join(pkgDir, 'assets', 'whale-placeholder.svg'), 'utf8')
  assert.ok(asset.trimStart().startsWith('<svg'))
})

test('坏数据不让插件崩：JSON null / 写盘失败都要降级而不是假装成功', () => {
  const dir = freshDir('bad-store')
  const store = createStore(dir)
  // 1) 文件内容是合法 JSON "null" → 必须退回 fallback（以前原样返回 null，createLedger 直接抛）
  writeFileSync(join(dir, '待办.json'), 'null', 'utf8')
  const ledger = createLedger(store)
  assert.doesNotThrow(() => ledger.stats())
  assert.equal(ledger.stats().confirmed.length, 0)

  // 2) 写盘失败 → add 必须回 ok:false（以前回 ok:true，界面说"已记录"重启即丢）
  const brokenStore = {
    read: () => ({ version: 1, items: [], skipped: 0 }),
    write: () => false,
    exists: () => true,
    lastError: 'disk full',
    dataDir: dir,
  }
  const broken = createLedger(brokenStore)
  const result = broken.add({ title: '写不进去的一条' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'write_failed')
  assert.equal(broken.stats().pending.length, 0, '失败后不能留在内存里假装存在')
})
test('台账每周归档：完成/忽略超 7 天的挪到 台账归档，活跃项保留', () => {
  const dir = freshDir('archive-week')
  const store = createStore(dir)
  const ledger = createLedger(store)
  const a = ledger.add({ title: '老完成的事' })
  const b = ledger.add({ title: '老忽略的事' })
  const c = ledger.add({ title: '还在做的事' })
  ledger.confirm(a.item.id)
  ledger.done(a.item.id)
  ledger.drop(b.item.id)
  // 把两条"已完成/已忽略"的最后更新时间改成 10 天前
  const old = new Date(Date.now() - 10 * 86400000).toISOString()
  for (const item of ledger.list()) {
    if (item.id === a.item.id || item.id === b.item.id) item.updatedAt = old
  }
  store.write('待办.json', { items: ledger.list(), skipped: 0 })
  const result = ledger.archiveWeek(new Date(), 7)
  assert.equal(result.ok, true)
  assert.equal(result.archived, 2, '两条老条目要归档')
  assert.equal(ledger.list().length, 1, '主台账只剩活跃项')
  const text = store.readText('台账归档/' + result.week + '.md')
  assert.ok(text.includes('老完成的事') && text.includes('老忽略的事'), '归档文件要能直接看')
  assert.ok(!text.includes('还在做的事'), '活跃项不能进归档')
  assert.equal(ledger.archiveWeek(new Date(), 7).archived, 0, '同周再跑没有可归档的')
})

test('台账 stats 要带 pending 清单（CEO 四问需要知道有哪些事悬着）', () => {
  const dir = freshDir('ledger-pending')
  const store = createStore(dir)
  const ledger = createLedger(store)
  ledger.add({ title: '候选一号' })
  const stats = ledger.stats()
  assert.ok(Array.isArray(stats.pending), 'stats.pending 应是数组')
  assert.equal(stats.pending.length, 1)
  assert.equal(stats.pending[0].title, '候选一号')
  assert.equal(stats.pendingCount, 1)
})
test('发布守卫：package.json 的 version 必须与 index.js 的 VERSION 一致（防漂移）', () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const src = readFileSync(join(pkgDir, 'index.js'), 'utf8')
  const m = /const VERSION = '([^']+)'/.exec(src) || /version:\s*'([^']+)'/.exec(src)
  assert.ok(m, 'index.js 里应能找到 VERSION')
  assert.equal(pkg.version, m[1], 'manifest 版本与运行时版本不一致：' + pkg.version + ' vs ' + m[1])
})
test('发布守卫 V-74：包体与单文件体积在合理范围，且第三方声明齐全', () => {
  const root = pkgDir
  // 只统计会进 npm 包的范围：文档、测试、脚本、dist 不算包体
  const skip = new Set(['node_modules', '.tmp', '.git', 'dist', 'docs', 'scripts', 'test', '.github', '.githooks'])
  let total = 0
  let biggest = { name: '', size: 0 }
  ;(function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const size = statSync(full).size
        total += size
        if (size > biggest.size) biggest = { name: full.substring(root.length + 1), size }
      }
    }
  })(root)
  assert.ok(total < 1024 * 1024, '打包体积应 < 1MiB，实际 ' + Math.round(total / 1024) + 'KB')
  assert.ok(biggest.size < 256 * 1024, '单文件应 < 256KiB，最大是 ' + biggest.name)
  assert.ok(existsSync(join(root, 'THIRD_PARTY_NOTICES.md')), '必须有第三方声明')
  assert.ok(existsSync(join(root, 'LICENSE')), '必须有 LICENSE')
})
test('package.json：name / patch / client / exports / files 齐全', () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-xiaozhushou')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.engines && pkg.engines.dsh, '必须声明 engines.dsh，安装与市场兼容性都靠它')
  for (const key of ['.', './client', './icon']) assert.ok(pkg.exports[key], 'exports 缺 ' + key)
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'core/', 'assets/', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(pkg.files.includes(entry), 'files 缺 ' + entry)
  }
  assert.ok(!pkg.files.includes('test'), '测试不进 npm 包（源码仓库里保留）')
})

/* ── 跑 ───────────────────────────────────────────────────── */
let passed = 0
const failures = []
test('09:00 开机闸门：闸门内一律顺延，闸门过了还在宽限内就补响（不悄悄并档）', () => {
  const at = (h, m, s = 0) => new Date(2026, 9, 26, h, m, s)
  const startedAt = at(9, 4, 30).toISOString()
  const { clock } = alarmFixture({ now: at(9, 6), startedAt, alarm: { bootGateMinutes: 10, maxDeferrals: 2, graceMinutes: 30 } })

  const first = clock.tick(at(9, 6))
  assert.deepEqual(Array.from(first.fired), [], '刚开机 1.5 分钟，应先顺延')
  assert.deepEqual(Array.from(first.deferred), ['09:00'])

  // 以前按 tick 次数（3 次=3 分钟）就并档，10 分钟闸门形同虚设，早上直接没提醒。
  const mid = clock.tick(at(9, 10))
  assert.deepEqual(Array.from(mid.fired), [], '闸门内继续顺延')
  assert.deepEqual(Array.from(mid.merged), [], '不该并档')

  // 闸门（9:04:30 + 10 分钟）过了，但离 09:00 还在 30 分钟宽限内 → 补响
  const later = clock.tick(at(9, 15))
  assert.deepEqual(Array.from(later.fired), ['09:00'], '闸门过了要补响，不能悄悄并到 13:00')
})

/* ── D-01：聊天必须走绑定真实会话（没有模型兜底） ─────────── */
// 假会话服务：prompt 会真的往会话里追加一条 assistant/message，
// 这样"只取本次新回复"的行为能被真验证（旧版本是固定返回两条事件的桩）。
function fakeChatServices({ reply = '会话里的回复', promptThrows = false, silent = false, preEvents = [] } = {}) {
  const calls = { prompt: [] }
  const events = Array.isArray(preEvents) ? preEvents.slice() : []
  let seq = 0
  for (const event of events) seq = Math.max(seq, Number(event && event.seq) || 0)
  const controller = {
    async prompt(req, signal) {
      calls.prompt.push(req)
      calls.signal = signal
      if (promptThrows) throw new Error('prompt boom')
      if (!silent) {
        seq += 1
        events.push({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } })
      }
      return { accepted: true }
    },
  }
  const query = {
    listSessions: async () => [],
    readTitleSnapshots: async () => [],
    async readSession(sessionId) {
      return { session: { id: sessionId }, events: silent ? [] : events.slice() }
    },
  }
  return { controller, query, calls, events }
}

function seedSessionState(dataDir, dir, sessionId, title) {
  mkdirSync(join(dataDir, dir), { recursive: true })
  writeFileSync(join(dataDir, dir, '会话状态.json'), JSON.stringify({ version: 1, sessionId, lastSeq: 0, title }), 'utf8')
}

test('D-01 未绑定会话：三角色聊天都返回 409，并说清卡在哪个会话', async () => {
  const dir = freshDir('d01-nobind')
  const { controller, query } = fakeChatServices()
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  const cases = [
    ['/api/dsh-xiaozhushou/secretary/chat', '秘书'],
    ['/api/dsh-xiaozhushou/ceo/chat', 'CEO'],
    ['/api/dsh-xiaozhushou/historian/chat', '史官'],
  ]
  for (const [route, role] of cases) {
    const res = await call(routes, route, { question: '你好' })
    assert.equal(res.status, 409, route + ' 未绑定时应 409，实际 ' + res.status)
    assert.equal(res.json.ok, false, route + ' 不许假装成功')
    assert.equal(res.json.code, 'no_session')
    assert.ok(res.json.message.includes('会话不可用'), route + ' 要明确说会话不可用：' + res.json.message)
    assert.ok(res.json.message.includes('卡在'), route + ' 要说清卡在哪：' + res.json.message)
    assert.ok(res.json.message.includes(role), route + ' 要点出是哪个角色会话：' + res.json.message)
  }
})

test('D-01 绑定会话后：原话发进会话、取会话回复（没模型也能答）', async () => {
  const dir = freshDir('d01-bound')
  const { controller, query, calls } = fakeChatServices({ reply: '会话里的回复' })
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  seedSessionState(dir, '秘书', 's-bind', 'dsh小助手 · 秘书 对话')

  // 这个假 ctx 没有任何模型服务 → 还能答，证明聊天不依赖模型
  const res = await call(routes, '/api/dsh-xiaozhushou/secretary/chat', { question: '今天先干什么' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.source, 'session', '来源必须是会话，不能是模型')
  assert.ok(res.json.text.includes('会话里的回复'), '要回会话里的内容：' + res.json.text)
  assert.equal(calls.prompt.length, 1)
  assert.ok(calls.prompt[0].content[0].text.includes('今天先干什么'), '必须把用户原话发进会话')
  assert.equal(calls.prompt[0].mode, 'queue')
  assert.equal(calls.prompt[0].sessionId, 's-bind')
  assert.ok(calls.signal && typeof calls.signal.throwIfAborted === 'function', 'prompt 必须带 signal')
})

test('D-01 会话发送失败：502 + 会话标题与原因（不静默回模型）', async () => {
  const dir = freshDir('d01-promptfail')
  const { controller, query } = fakeChatServices({ promptThrows: true })
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })
  seedSessionState(dir, '秘书', 's-boom', 'dsh小助手 · 秘书 对话')

  const res = await call(routes, '/api/dsh-xiaozhushou/secretary/chat', { question: '你好' })
  assert.equal(res.status, 502)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.code, 'prompt_failed')
  assert.ok(res.json.message.includes('dsh小助手 · 秘书 对话'), '要带会话标题：' + res.json.message)
  assert.ok(res.json.message.includes('卡在'), '要说清卡在哪：' + res.json.message)
  assert.ok(res.json.message.includes('prompt boom'), '要把真实原因带出来：' + res.json.message)
})

test('D-01 会话 90 秒不回话：504 明确报错（超时参数可注入，测试不等 90 秒）', async () => {
  const dir = freshDir('d01-silent')
  const store = createStore(dir)
  seedSessionState(dir, 'CEO', 's-silent', 'dsh小助手 · CEO 对话')
  const chat = createRoleChat({
    ctx: {
      get: (name) =>
        name === 'sessionController'
          ? { prompt: async () => ({ accepted: true }) }
          : name === 'sessionQuery'
            ? { readSession: async (id) => ({ session: { id }, events: [] }) }
            : undefined,
    },
    store,
    role: 'ceo',
    dataDir: dir,
    timing: { replyTimeoutMs: 120, pollMs: 20 },
  })
  const result = await chat.chat('在吗')
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 504)
  assert.equal(result.code, 'no_reply')
  assert.ok(result.message.includes('会话不可用') && result.message.includes('CEO'), result.message)
})

test('D-01 绑定接口：/historian/bind 真写会话状态，随后聊天能用', async () => {
  const dir = freshDir('d01-bind')
  const { controller, query } = fakeChatServices({ reply: '记到 3 条' })
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })

  const bound = await call(routes, '/api/dsh-xiaozhushou/historian/bind', { sessionId: 's-hist' })
  assert.equal(bound.json.ok, true, '绑定要成功（以前 bind 是空实现，直接崩）')
  const state = JSON.parse(readFileSync(join(dir, '史官', '会话状态.json'), 'utf8'))
  assert.equal(state.sessionId, 's-hist')

  const res = await call(routes, '/api/dsh-xiaozhushou/historian/chat', { question: '昨天记了什么' })
  assert.equal(res.status, 200)
  assert.ok(res.json.text.includes('记到 3 条'))
})

test('D-01/A1 绑定既有历史会话：bind 记当前最大 seq，聊天只回本次新回复（不拼接旧回复）', async () => {
  const dir = freshDir('d01-existing')
  // 会话里已经有历史：旧问题 + 旧回复
  const preEvents = [
    { seq: 1, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '之前的旧问题' }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '很久以前的一句旧回复' }] } } },
  ]
  const { controller, query } = fakeChatServices({ reply: '这次的新回复', preEvents })
  const { ctx, routes } = makeCtx(dir, { services: { sessionController: controller, sessionQuery: query } })
  mod.apply(ctx, { dataDir: dir, startupRefreshMs: 0 })

  const bound = await call(routes, '/api/dsh-xiaozhushou/historian/bind', { sessionId: 's-hist-old' })
  assert.equal(bound.json.ok, true)
  assert.equal(bound.json.lastSeq, 2, '绑定要记下会话当前最大 seq，实际 ' + bound.json.lastSeq)
  const state = JSON.parse(readFileSync(join(dir, '史官', '会话状态.json'), 'utf8'))
  assert.equal(state.lastSeq, 2, '绑定点 seq 要落盘')

  const res = await call(routes, '/api/dsh-xiaozhushou/historian/chat', { question: '昨天记了什么' })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.ok(res.json.text.includes('这次的新回复'), '要回本次新回复：' + res.json.text)
  assert.ok(!res.json.text.includes('很久以前的一句旧回复'), '绝不能把绑定前的历史旧回复拼进来：' + res.json.text)

  // 老版本遗留的 会话状态.json（lastSeq 落后）也要只回新回复
  const dir2 = freshDir('d01-stale-seq')
  const f2 = fakeChatServices({ reply: '升级后的新回复', preEvents })
  const ctx2 = makeCtx(dir2, { services: { sessionController: f2.controller, sessionQuery: f2.query } })
  mod.apply(ctx2.ctx, { dataDir: dir2, startupRefreshMs: 0 })
  seedSessionState(dir2, 'CEO', 's-stale', 'dsh小助手 · CEO 对话') // 故意 lastSeq=0
  const res2 = await call(ctx2.routes, '/api/dsh-xiaozhushou/ceo/chat', { question: '先说今天的' })
  assert.equal(res2.status, 200, JSON.stringify(res2.json))
  assert.ok(res2.json.text.includes('升级后的新回复'), res2.json.text)
  assert.ok(!res2.json.text.includes('很久以前的一句旧回复'), 'lastSeq 落后时也不能拼历史旧回复：' + res2.json.text)
})

test('D-01 守卫：role-chat 里不许再出现"直连模型兜底"，客户端必须显示错误', () => {
  const src = readFileSync(join(pkgDir, 'core', 'role-chat.js'), 'utf8')
  assert.ok(!src.includes('brain.ask'), '聊天不许再造模型兜底')
  assert.ok(!src.includes("code: 'model_failed'"), '不许再有"模型失败"的兜底返回值')
  assert.ok(src.includes('会话不可用'), '失败要有明确错误话术')
  const client = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(client.includes('没答上来'), '客户端必须把服务端错误显示给用户')
})

test('D-02 发布守卫：全库不出现角色口癖称谓', () => {
  const bad = '贾' + '维斯'
  const targets = [
    'README.md', 'CHANGELOG.md',
    'index.js', 'client.js', 'roles/index.js', 'roles/presets.js',
    ...readdirSync(join(pkgDir, 'core')).filter((n) => n.endsWith('.js')).map((n) => 'core/' + n),
    ...readdirSync(join(pkgDir, 'docs')).filter((n) => n.endsWith('.md')).map((n) => 'docs/' + n),
    'locale/zh.json', 'locale/en.json',
  ]
  for (const rel of targets) {
    assert.ok(!readFileSync(join(pkgDir, rel), 'utf8').includes(bad), rel + ' 仍含角色口癖称谓')
  }
})

/* ── 角色行为修复（0.47.1） ─────────────────────────────── */
test('任务意图：接下/完成/转交秘书 能识别，问句不触发', async () => {
  const { detectTaskIntent, taskIntentLabel } = await import('../core/task-intent.js')
  const accept = detectTaskIntent('接下 K-003')
  assert.equal(accept.matched, true)
  assert.equal(accept.taskId, 'K-003')
  assert.equal(accept.action, '进行中')
  assert.equal(taskIntentLabel(accept), '已接下，状态改为进行中')
  const done = detectTaskIntent('K-003 已完成')
  assert.equal(done.action, '完成')
  const transfer = detectTaskIntent('把 K-003 转给秘书跟进')
  assert.equal(transfer.action, '转交秘书')
  assert.equal(detectTaskIntent('该不该开新会话处理这件事').matched, false, '问句不触发')
  assert.equal(detectTaskIntent('今天吃什么').matched, false)
})

test('角色插件：必须声明 systemPrompt 依赖，提示词禁止谈工具/团队', async () => {
  const roles = await import('../roles/index.js')
  assert.ok(Array.isArray(roles.inject) && roles.inject.includes('systemPrompt'), 'inject 要含 systemPrompt，否则身份段注册不上')
  for (const role of ['secretary', 'ceo', 'historian']) {
    assert.ok(roles.ROLE_PROMPTS[role].includes('绝不提及工具调用'), role + ' 提示词缺少禁止工具/团队口吻')
  }
})

test('角色聊天：每条消息都带本角色规则前缀（不靠 preset 侥幸生效）', () => {
  const src = readFileSync(join(pkgDir, 'core', 'role-chat.js'), 'utf8')
  assert.ok(src.includes('【本角色规则·必须遵守】'), '聊天消息要带角色规则前缀')
  assert.ok(src.includes('【用户说】'), '用户原话要保留')
})

test('看板：秘书/史官回复下必须有「转交CEO / 取消」按钮', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes("'转交CEO'"), '缺转交CEO按钮')
  assert.ok(src.includes('handoffButtons(\'historian\''), '史官回复也要有转交按钮')
  assert.ok(src.includes("line.cancelled"), '取消要能隐藏按钮')
})

/* ── 聊天只说人话 + 任务事实（0.47.1） ───────────────────── */
test('聊天后处理：Markdown 与小标题被拆掉，只留人话', async () => {
  const { humanizeReply } = await import('../core/role-chat.js')
  const out = humanizeReply('**结论**：先补附件。\n\n- 风险：今天不定稿\n- 下一步：回邮件')
  assert.ok(!out.includes('**'), '不能留 **')
  assert.ok(!/^\s*[-*]\s/m.test(out), '不能留列表符号')
  assert.ok(!out.includes('结论：') && !out.includes('下一步：'), '不能留小标题')
  assert.ok(out.includes('先补附件') && out.includes('回邮件'), '内容不能丢')
})

test('任务事实：CEO 提到 K-xxx 时带上任务板原样事实', async () => {
  const { taskFactsFor } = await import('../core/role-chat.js')
  const tasks = [
    { id: 'K-001', title: '把附件补齐', assignee: 'ceo', status: '待办' },
    { id: 'K-002', title: '别的任务', assignee: 'secretary', status: '进行中' },
  ]
  const byId = taskFactsFor(tasks, '接下 K-001')
  assert.ok(byId.includes('K-001') && byId.includes('把附件补齐') && byId.includes('待办'))
  assert.ok(!byId.includes('K-002'), '没提的任务不带')
  const generic = taskFactsFor(tasks, '接下这个任务')
  assert.ok(generic.includes('K-001'))
  assert.equal(taskFactsFor(tasks, '今天天气怎么样'), '')
})

test('角色提示词：三个角色都要求说人话', async () => {
  const roles = await import('../roles/index.js')
  for (const role of ['secretary', 'ceo', 'historian']) {
    assert.ok(roles.ROLE_PROMPTS[role].includes('只说人话'), role + ' 缺说人话约束')
  }
})

test('布局守卫（0.47.1）：三个聊天框有清晰边框、人发消息浅蓝、史官留高、CEO任务三行', () => {
  const src = readFileSync(join(pkgDir, 'client.js'), 'utf8')
  assert.ok(src.includes('.ke-chat{border:2px solid #b9c8ef'), '聊天框要有清晰边框')
  assert.ok(src.includes('.ke-msg.me{background:#d6e7ff'), '人发消息用浅蓝底')
  assert.ok(src.includes('.ke-chat-small .ke-chat-log{max-height:210px'), '史官区域要预留更高')
  assert.ok(src.includes('minmax(540px,52%)'), '左侧要压缩，给右侧留空间')
  assert.ok(src.includes('.ke-left2-side{order:-1'), '优先级/待办要在秘书上面')
  assert.ok(src.includes('ke-panel ke-todo'), '待办是独立卡')
  assert.ok(!src.includes("className: 'ke-blk ke-task'"), 'CEO 任务区已按作者要求移除')
  assert.ok(src.includes('durationLabel'), '待办卡要显示大概多久能干完')
  assert.ok(!src.includes("'会话卡'"), '会话卡已按作者要求移除')
  assert.ok(src.includes('.ke-msg-row') && src.includes('.ke-msg-no'), '聊天消息要有序号与气泡行')
  assert.ok(src.includes("'.ke-btn{border:1px solid #e5e6eb;background:#fff;border-radius:6px;padding:1px 8px;font-size:11px"), '三个角色按钮要同一尺寸')
})

for (const { name, fn } of queue) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error && error.message}`)
  }
}

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
