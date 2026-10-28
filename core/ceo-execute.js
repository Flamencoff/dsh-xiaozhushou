/**
 * CEO 硬动作执行（D-20 ②）：用户说"开新会话执行 …"→ 真的建一个 CEO 预设会话。
 *
 * 为什么单独一个模块：
 *   意图识别与"开会话"是两件事，放在一起才好单测；聊天路由只负责被调用与错误透传。
 *
 * 流程（复用 core/spawn.js 的 create → rename → prompt）：
 *   1) 命中"开新会话 + 执行/做/处理/跑"→ 取后半句当任务；
 *   2) 建会话：agentPreset = 'steward-ceo'，标题 `dsh小助手 · CEO 执行`；
 *   3) 把任务写进第一句（prompt），返回会话名/ID；
 *   4) 权限审批由宿主在**那个会话里**弹，插件不代点、不假装已批准；
 *   5) 开会话失败 → 明确错误（code + httpStatus + message），不静默、不降级。
 *
 * 依赖规则：只 import node: 与 relative；spawner 显式注入。
 */

export const EXECUTE_TITLE = 'dsh小助手 · CEO 执行'
export const EXECUTE_PRESET = null

/**
 * 识别"开新会话执行 …"意图。
 * @param {string} text
 * @returns {{matched:boolean, task:string}}
 */
export function detectExecuteIntent(text) {
  const raw = String(text || '').trim()
  if (!raw) return { matched: false, task: '' }
  // 安全边界：征询/否定不算命令（"要不要开…""先别开…"），绝不拿问句去建会话
  if (/^(要不要|是不是|该不该|需不需要|能不能|可不可以|是否|要不要我)/.test(raw)) return { matched: false, task: '' }
  if (/^(先别|别|不要|暂时别)/.test(raw)) return { matched: false, task: '' }
  const wantsSession = /(?:开|建|创建|新开)\s*(?:一个|个)?\s*(?:新)?\s*会话|新会话/i.test(raw)
  const wantsAction = /(?:执行|做|处理|跑|干|办理)/.test(raw)
  if (!wantsSession || !wantsAction) return { matched: false, task: '' }

  // 取"执行/做/处理/跑/干/办理"之后的部分；没有就退回整句（至少别把任务丢了）
  const after = /(?:执行|做|处理|跑|干|办理)\s*[:：,，、]?\s*([\s\S]+)$/.exec(raw)
  const task = String((after && after[1]) || raw)
    .replace(/^[，,。；;\s]+/, '')
    .trim()
  return { matched: true, task }
}

/** 组第一句：任务 + 边界 + 审批提示（确定性，不调模型） */
export function buildExecutePrompt(task, options = {}) {
  const card = String(options.handoffCard || '').trim()
  return (
    '任务：' + String(task || '').trim() + '\n\n' +
    (card ? '交接卡：' + card + '（先读这张卡：任务、背景、边界、交付物、验收）\n\n' : '') +
    '（这是 CEO 开的普通任务会话：先复述任务与边界，再开始执行；' +
    '需要读写文件、跑命令等权限时，在本会话里向我申请，不要假装已经批准。）'
  )
}

/**
 * @param {{spawner:{spawn:Function}}} deps
 */
export function createCeoExecutor({ spawner }) {
  async function execute({ text, task, handoffCard } = {}) {
    const intent = detectExecuteIntent(text)
    const wanted = String(task || '').trim() || intent.task
    if (!wanted) {
      return { ok: false, code: 'empty_task', httpStatus: 400, message: '要执行什么？说清楚一点，例如：开新会话执行 整理三季度材料' }
    }
    if (!spawner || typeof spawner.spawn !== 'function') {
      return { ok: false, code: 'no_spawner', httpStatus: 503, message: '这个环境不能开新会话（spawner 不可用），任务没执行' }
    }
    const spawned = await spawner.spawn({
      title: EXECUTE_TITLE,
      prompt: buildExecutePrompt(wanted, { handoffCard }),
      ...(EXECUTE_PRESET ? { agentPreset: EXECUTE_PRESET } : {}),
      confirmedByAuthor: true,
    })
    if (!spawned || !spawned.ok) {
      return {
        ok: false,
        code: (spawned && spawned.code) || 'spawn_failed',
        httpStatus: 502,
        sessionId: (spawned && spawned.sessionId) || null,
        task: wanted,
        message: '开新会话失败：' + String((spawned && spawned.message) || '没建起来') + '（任务没有执行）',
      }
    }
    return {
      ok: true,
      executed: true,
      task: wanted,
      sessionId: spawned.sessionId,
      sessionTitle: EXECUTE_TITLE,
      agentPreset: EXECUTE_PRESET,
      message: '已开好任务会话「' + EXECUTE_TITLE + '」（' + spawned.sessionId + '）：任务和交接卡写进第一句，权限审批会在该会话里弹。',
    }
  }

  return { execute }
}
