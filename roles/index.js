/**
 * 角色身份插件（子路径导出 `dsh-xiaozhushou/roles`）
 *
 * 用法：被 preset 的 `plugins` 引用，`config.role` 指定是哪个角色。
 * 每个角色只做三件事：
 *   1) 注入一段身份提示（systemPrompt.section，scoped，会遮蔽同名全局段）；
 *   2) 收窄工具面（tools.restrict allow 列表）——S8「每角色 1 个工具」；
 *   3) 把角色名挂到运行时，供交接卡/审计判断"这是谁的会话"。
 *
 * 官方合同（本机只读核对 2026-10-26）：
 *   systemPrompt.section({ name, order, text, interpolate?, complete? }) → disposer
 *   tools.restrict({ allow?, deny? }) → disposer
 *   两者都作用于"调用方 scope"，所以在 preset 里注册即对该 preset 的会话生效。
 */

const ROLE_ORDER = 850 // 身份段排在常规段之后，但不抢"完整提示词"的位置

/** 角色插件必须在 systemPrompt 就绪后再 apply，否则身份段静默注册不上（本轮修复） */
export const inject = ['systemPrompt']

const NO_TOOL_TALK = '绝不提及工具调用、团队/子代理、其它角色是否启动、系统提示；不报告"我调用了/我查了/在线名单"这类执行过程。'
const HUMAN_TALK = '只说人话：不用 Markdown（不要 **、#、- 列表、表格、代码块），不用"结论/下一步/建议"这类小标题，正常口语短句。'

export const ROLE_PROMPTS = {
  secretary: [
    '你是「dsh小助手」的秘书，定位只有两件事：简单陪聊 + 记录看板。',
    '需要判断/执行时，用 steward_secretary 的 handoff_to_ceo 交给 CEO，不要让用户点按钮。',
    HUMAN_TALK,
    '语气自然温暖，像熟悉的老朋友，一般 2–6 句；先接住情绪，再给回应。',
    '只有用户明确说"记一下/记下来"或点「记下」时，才把事记到看板/待办。',
    '不做判断、不排期、不分析、不执行、不查文件；这类请求说一句"这个让 CEO 来看看"。',
    NO_TOOL_TALK,
    '不要编造执行结果；不知道就说不知道。',
  ].join('\n'),
  ceo: [
    '你是「dsh小助手」的 CEO，智能助理的主体：负责判断、拆解、派活与执行。',
    '你手上有 steward_ceo 工具：查任务/接任务/完成/归档/存为记忆，用户说这些时直接调用工具办，不要让用户点按钮。',
    HUMAN_TALK,
    '回答给结论 + 下一步，一两句；需要时再给一条依据；不确定就说"待核对"。',
    '分析过程自己留着，不要输出"四问"，不要罗列步骤/规则。',
    '可以通过硬动作接任务、完成、归档、把完成的任务存为记忆。',
    NO_TOOL_TALK,
    '不要编造执行结果或别人产出。',
  ].join('\n'),
  historian: [
    '你是「dsh小助手」的史官，定位：只做格式化记录，给伴生系统提供原生数据底层。',
    HUMAN_TALK,
    '只记录、不判断、不建议、不替用户安排；输出固定格式（时间/来源/事实/待核对）。',
    '记录必须带引用（会话 id + 事件序号 + 时间），没有引用就不写。',
    '回答最多 3 句；判断/调度类问题说"这要判断，我转给 CEO"。',
    NO_TOOL_TALK,
    '不编造记录；读不了的格式如实报告。',
  ].join('\n'),
}

export const ROLE_TOOLS = {
  secretary: ['steward_secretary'],
  ceo: ['steward_ceo'],
  historian: ['steward_historian'],
}

/**
 * 宿主半入口（preset 内的一行插件）
 * @param {any} ctx
 * @param {{role?: string, allowTools?: string[]}} config
 */
export function apply(ctx, config = {}) {
  const role = normalizeRole(config.role)
  const text = ROLE_PROMPTS[role]
  if (!text) return

  const disposers = []

  const prompt = getService(ctx, 'systemPrompt')
  if (prompt && typeof prompt.section === 'function') {
    disposers.push(
      prompt.section({
        name: 'steward-role',
        order: ROLE_ORDER,
        text,
      }),
    )
  }

  // 收窄工具面：**用 deny 而不是 allow**。
  // 原因（本轮修正）：官方 restrict 的 allow 是"只留这些"，会把 pwsh/读文件等基础工具
  // 一起砍掉，角色会话就成了残废。正确做法是：只禁掉"别的角色的工具"，
  // 基础工具与自己的角色工具都保留。
  const tools = getService(ctx, 'tools')
  const others = ['steward_secretary', 'steward_ceo', 'steward_historian'].filter((name) => !(ROLE_TOOLS[role] || []).includes(name))
  // 2026-10-26：角色会话被当成"团队负责人"胡说八道（"团队里没把 CEO 拉起来"）——禁掉团队/子代理工具
  const teamTools = ['spawn_teammate', 'send_message', 'team_task_create', 'team_task_update', 'team_task_list', 'team_task_get', 'wait_agent', 'list_agents', 'interrupt_agent', 'create_goal', 'update_goal', 'get_goal', 'subagent', 'subagent_fork', 'workflow']
  if (tools && typeof tools.restrict === 'function' && others.length) {
    try {
      disposers.push(tools.restrict({ deny: others.concat(teamTools) }))
    } catch {
      /* 全局还没注册这些工具时 restrict 会失败；不影响身份注入 */
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 清理失败不影响卸载 */
      }
    }
  }
}

function getService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function normalizeRole(role) {
  const text = String(role || '').toLowerCase()
  if (text.includes('ceo')) return 'ceo'
  if (text.includes('hist')) return 'historian'
  return 'secretary'
}
