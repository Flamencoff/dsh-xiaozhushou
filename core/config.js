/**
 * 配置：默认值 + 校验 + 收敛（18_详细设计 §7）
 *
 * 用普通对象读 row 的 config，不做官方 Config Schema（M2 先不引入 schema 依赖）；
 * 所有非法值一律回退到默认，并记一条 warning 给 /health 显示，不抛错。
 */

export const DEFAULT_CONFIG = {
  // 0.47.0（框架 v2 · D-05/06）：发布默认三个角色都开；史官可读真实会话。
  // 开发/测试想回到隐私优先：enabled.historian 可关，historian.scope.mode 改 'sandbox'。
  enabled: { secretary: true, ceo: true, historian: true },
  historian: {
    tier: 'summary',
    fullTierWorkspaces: [],
    // 默认每个会话只扫末尾 100 条（可选 100/200/300/自定义）
    budgets: { maxEvents: 100, maxTokens: 8000, windowHours: 72 },
    // 发布默认读全部会话（mode: 'all'）；sandbox 只读标题以 [实验] 开头的测试会话 + 三个角色会话
    scope: { mode: 'all', prefixes: ['[实验]'] },
    exclude: [],
  },
  alarm: {
    fixedTimes: ['09:00', '13:00', '18:00'],
    quietHours: { from: '23:00', to: '07:00' },
    dedupeMinutes: 60,
    bootGateMinutes: 10,
    maxDeferrals: 3,
    graceMinutes: 30,
    // 默认不叫模型写开场白（提醒照常；要模型开场白必须显式打开）
    lightModel: { enabled: false, maxTokens: 400, maxItems: 3, complexityThreshold: 3 },
    push: { enabled: true, maxItems: 3 },
  },
  // M4 模型版 + K1 轻量唤醒：允许真调模型，但有开关、上限、超时
  model: { enabled: true, maxTokens: 500, timeoutMs: 20000, temperature: 0.3 },
  // 启动后延迟多少毫秒做第一次采集（避免和 DSH 启动抢资源；测试里设 0）
  startupRefreshMs: 1200,
  // A3 沙盒：只往标题以 [实验] 开头的会话推，绝不写用户真实会话
  sandbox: { enabled: true, sessionTitlePrefix: '[实验]', allowedSessionIds: [], maxPushPerDay: 6 },
  privacy: { reduceAuthorGranularity: true },
  // A1（用户 2026-10-26 批）：三角色工具默认注册；不想要可在设置里关
  tools: { enabled: true },
  // 开会话以界面按钮为准；模型工具路径默认关闭（要开需显式配置 true）
  session: { allowModelOpenSession: false },
  // 找文件：只在这些根目录里搜（不配就用数据目录的上一级）
  // 2026-10-26 修 FIX-03：默认只按文件名找（隐私）；要搜内容必须显式 find.content:true
  find: { allowedRoots: [], content: false },
  roles: { registerPresets: true },
  pet: { enabled: true },
  limits: { roleSteps: { secretary: 8, ceo: 30, historian: 60 } },
}

export function resolveConfig(raw) {
  const warnings = []
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = deepClone(DEFAULT_CONFIG)

  if (input.dataDir !== undefined) {
    if (typeof input.dataDir === 'string' && input.dataDir.trim()) config.dataDir = input.dataDir.trim()
    else warnings.push('dataDir 要写非空字符串，已忽略')
  }

  if (input.historian && typeof input.historian === 'object') {
    const tier = input.historian.tier
    if (['summary', 'body', 'full'].includes(tier)) config.historian.tier = tier
    else if (tier !== undefined) warnings.push('historian.tier 只能是 summary/body/full，已用默认 summary')
    if (Array.isArray(input.historian.exclude)) config.historian.exclude = input.historian.exclude.map(String)
    // 2026-10-26 修 A-07：budgets 以前只写在默认值里、根本不解析，用户配了也没用
    if (input.historian.scope && typeof input.historian.scope === 'object') {
      const scope = input.historian.scope
      if (scope.mode === 'all' || scope.mode === 'sandbox') config.historian.scope.mode = scope.mode
      if (Array.isArray(scope.prefixes)) config.historian.scope.prefixes = scope.prefixes.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    }
    if (input.historian.budgets && typeof input.historian.budgets === 'object') {
      const b = input.historian.budgets
      config.historian.budgets.maxEvents = clampInt(b.maxEvents, 10, 5000, config.historian.budgets.maxEvents)
      config.historian.budgets.maxTokens = clampInt(b.maxTokens, 500, 200000, config.historian.budgets.maxTokens)
      config.historian.budgets.windowHours = clampInt(b.windowHours, 1, 24 * 365, config.historian.budgets.windowHours)
    }
  }

  // 2026-10-26 修 A-07：找文件的白名单根目录以前不可配（find 永远全工作区内容检索）
  if (input.find && typeof input.find === 'object') {
    if (Array.isArray(input.find.allowedRoots)) {
      config.find.allowedRoots = input.find.allowedRoots
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    }
    // 2026-10-26 修 FIX-03：不配置就是 false（只按文件名）；显式 true 才搜内容
    config.find.content = input.find.content === true
  }
  if (input.enabled && typeof input.enabled === 'object') {
    for (const role of ['secretary', 'ceo', 'historian']) {
      if (typeof input.enabled[role] === 'boolean') config.enabled[role] = input.enabled[role]
    }
  }

  if (input.alarm && typeof input.alarm === 'object') {
    const alarm = input.alarm
    if (Array.isArray(alarm.fixedTimes)) {
      const times = alarm.fixedTimes.filter(isClock).sort()
      if (times.length) config.alarm.fixedTimes = times
      else warnings.push('alarm.fixedTimes 没有合法时间（要 HH:mm），已用默认')
    }
    if (isClock(alarm.quietHours && alarm.quietHours.from) && isClock(alarm.quietHours.to)) {
      config.alarm.quietHours = { from: alarm.quietHours.from, to: alarm.quietHours.to }
    }
    config.alarm.dedupeMinutes = clampInt(alarm.dedupeMinutes, 0, 24 * 60, config.alarm.dedupeMinutes)
    config.alarm.bootGateMinutes = clampInt(alarm.bootGateMinutes, 0, 120, config.alarm.bootGateMinutes)
    config.alarm.maxDeferrals = clampInt(alarm.maxDeferrals, 0, 10, config.alarm.maxDeferrals)
    config.alarm.graceMinutes = clampInt(alarm.graceMinutes, 1, 240, config.alarm.graceMinutes)
  }

  if (input.pet && typeof input.pet.enabled === 'boolean') config.pet.enabled = input.pet.enabled

  if (input.tools && typeof input.tools.enabled === 'boolean') config.tools.enabled = input.tools.enabled

  if (input.session && typeof input.session === 'object' && typeof input.session.allowModelOpenSession === 'boolean') {
    config.session.allowModelOpenSession = input.session.allowModelOpenSession
  }

  if (input.startupRefreshMs !== undefined) config.startupRefreshMs = clampInt(input.startupRefreshMs, 0, 10000, config.startupRefreshMs)

  if (input.model && typeof input.model === 'object') {
    if (typeof input.model.enabled === 'boolean') config.model.enabled = input.model.enabled
    config.model.maxTokens = clampInt(input.model.maxTokens, 32, 4000, config.model.maxTokens)
    config.model.timeoutMs = clampInt(input.model.timeoutMs, 1000, 120000, config.model.timeoutMs)
    if (Number.isFinite(Number(input.model.temperature))) config.model.temperature = Number(input.model.temperature)
  }

  if (input.sandbox && typeof input.sandbox === 'object') {
    // 2026-10-26 修 A-14：sandbox.enabled=false 以前只是"文案开关"，实际仍然强制 [实验] 前缀，
    // 等于假开关。现在明确拒绝并告警——安全红线不允许把提醒推给用户真实会话。
    if (input.sandbox.enabled === false) {
      warnings.push('sandbox.enabled=false 不被支持（安全红线：只推 [实验] 会话），已忽略')
    }
    if (typeof input.sandbox.sessionTitlePrefix === 'string' && input.sandbox.sessionTitlePrefix) config.sandbox.sessionTitlePrefix = input.sandbox.sessionTitlePrefix
    if (Array.isArray(input.sandbox.allowedSessionIds)) config.sandbox.allowedSessionIds = input.sandbox.allowedSessionIds.map(String)
    config.sandbox.maxPushPerDay = clampInt(input.sandbox.maxPushPerDay, 1, 50, config.sandbox.maxPushPerDay)
  }

  if (input.alarm && input.alarm.push && typeof input.alarm.push === 'object') {
    if (typeof input.alarm.push.enabled === 'boolean') config.alarm.push.enabled = input.alarm.push.enabled
    config.alarm.push.maxItems = clampInt(input.alarm.push.maxItems, 1, 10, config.alarm.push.maxItems)
  }

  if (input.roles && typeof input.roles.registerPresets === 'boolean') config.roles.registerPresets = input.roles.registerPresets

  if (input.privacy && typeof input.privacy === 'object' && typeof input.privacy.reduceAuthorGranularity === 'boolean') {
    config.privacy.reduceAuthorGranularity = input.privacy.reduceAuthorGranularity
  }

  if (input.alarm && input.alarm.lightModel && typeof input.alarm.lightModel === 'object') {
    const lm = input.alarm.lightModel
    if (typeof lm.enabled === 'boolean') config.alarm.lightModel.enabled = lm.enabled
    config.alarm.lightModel.maxTokens = clampInt(lm.maxTokens, 50, 4000, config.alarm.lightModel.maxTokens)
    config.alarm.lightModel.maxItems = clampInt(lm.maxItems, 1, 10, config.alarm.lightModel.maxItems)
    config.alarm.lightModel.complexityThreshold = clampInt(lm.complexityThreshold, 1, 20, config.alarm.lightModel.complexityThreshold)
  }

  return { config, warnings }
}

/* ── 小工具 ─────────────────────────────────────────────── */

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function isClock(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function minutesOf(clock) {
  const [h, m] = clock.split(':').map(Number)
  return h * 60 + m
}
