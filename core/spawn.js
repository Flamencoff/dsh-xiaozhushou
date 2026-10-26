/**
 * 全自动开新会话（K3 决定：口头确认即全自动，用户不动手）
 *
 * 流程（全部由插件完成，用户只需说一句"开"）：
 *   1) sessionController.create({ workspaceId?, cwd?, agentPreset? })  → sessionId
 *   2) sessionController.rename({ sessionId, title })                 → 标题
 *   3) sessionController.prompt({ requestId, sessionId, mode:'queue', content }) → 第一句
 *
 * 安全前提（13 R-07.6 / 01 §七.2）：
 *   · 必须带 `confirmedByAuthor: true`——这是"用户口头同意"的凭证，函数自己不会去猜；
 *   · 传 false 或缺省 → 直接拒绝，不创建任何东西。
 *
 * 契约来源：本机 cordis_inspect_query · host `sessionController`（2026-10-26 核对）。
 */

import { randomUUID } from 'node:crypto'

// 开新会话的频次闸门：一小时内最多 4 次（2026-10-26 补：以前只有"要用户同意"，
// 没有频率上限，模型可以连续开着玩，白烧 token）
const MAX_PER_HOUR = 4
const HOUR_MS = 60 * 60 * 1000

export function createSpawner(ctx) {
  // 每个 spawner 自己一份计数（模块级会跨实例/跨测试串味）
  const recentSpawns = []
  function rateLimited(now = Date.now()) {
    while (recentSpawns.length && now - recentSpawns[0] > HOUR_MS) recentSpawns.shift()
    return recentSpawns.length >= MAX_PER_HOUR
  }
  function controller() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    } catch {
      return undefined
    }
  }

  /**
   * @param {{title:string, prompt:string, cwd?:string, agentPreset?:string, confirmedByAuthor:boolean}} request
   */
  async function spawn(request) {
    const { title, prompt, cwd, agentPreset, confirmedByAuthor } = request || {}

    if (confirmedByAuthor !== true) {
      return fail('not_confirmed', '开新会话要先经用户口头同意；你说一句"开"，我再动手')
    }
    if (!title || !String(title).trim()) {
      return fail('empty_title', '新会话得有个标题')
    }
    if (!prompt || !String(prompt).trim()) {
      return fail('empty_prompt', '新会话第一句要写清楚干什么')
    }

    if (rateLimited()) {
      return fail('rate_limited', '一小时最多开 ' + MAX_PER_HOUR + ' 个新会话，先把手上的事做完')
    }

    const svc = controller()
    if (!svc || typeof svc.create !== 'function') {
      return fail('no_controller', '这个环境不支持自动建会话（sessionController 不可用）')
    }

    const steps = []
    let sessionId = null

    try {
      const created = await svc.create({ ...(cwd ? { cwd } : {}), ...(agentPreset ? { agentPreset } : {}) })
      sessionId = created && created.sessionId
      steps.push({ step: 'create', ok: Boolean(sessionId), sessionId })
      if (!sessionId) return fail('create_failed', '建会话没成功')
    } catch (error) {
      return fail('create_failed', '建会话失败：' + messageOf(error))
    }

    // 标题失败不致命：会话已经建好，标题可以后补
    try {
      if (typeof svc.rename === 'function') {
        await svc.rename({ sessionId, title: String(title).trim().slice(0, 80) })
        steps.push({ step: 'rename', ok: true })
      }
    } catch (error) {
      steps.push({ step: 'rename', ok: false, reason: messageOf(error) })
    }

    try {
      if (typeof svc.prompt === 'function') {
        // 官方合同：prompt(request, signal) —— signal 是**第二个位置参数**，漏传会在远端抛
        // "Cannot read properties of undefined (reading 'throwIfAborted')"
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30_000)
        try {
          await svc.prompt(
            {
              requestId: randomUUID(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: String(prompt) }],
            },
            controller.signal,
          )
        } finally {
          clearTimeout(timer)
        }
        steps.push({ step: 'prompt', ok: true })
      }
    } catch (error) {
      return { ok: false, code: 'prompt_failed', message: '会话建好了但第一句没发出去：' + messageOf(error), sessionId, steps }
    }

    recentSpawns.push(Date.now())
    return { ok: true, sessionId, steps, message: '新会话开好了，标题和第一句都备齐了' }
  }

  return { spawn }
}

function fail(code, message) {
  return { ok: false, code, message }
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}
