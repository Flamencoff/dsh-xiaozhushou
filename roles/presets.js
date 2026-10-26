/**
 * 三个角色 preset 的声明（N-2）
 *
 * 官方 preset 的声明形式（只读核对了官方 preset 的 README）：
 *   { id, name?, description?, order?, plugins: EntryOptions[] }
 *   plugins 可为空（标准预设就是空数组），说明基座插件不由 preset 声明。
 *
 * 所以每个角色 preset 的 `plugins` 只放一行：我们自己的角色身份插件。
 * preset 一旦被会话选中，`SessionHeader.agentPreset` 就能读到，CEO 可据此判断会话身份。
 */

export const ROLE_PRESETS = [
  {
    id: 'steward-secretary',
    role: 'secretary',
    name: 'dsh小助手 · 秘书',
    description: '唯一对话入口：记待办、查状态、一句话摘要、提醒。不做判断。',
    order: 10,
  },
  {
    id: 'steward-ceo',
    role: 'ceo',
    name: 'dsh小助手 · CEO',
    description: '做判断：四问 + 单线分析、拆活、写交接卡与待拍板清单。',
    order: 20,
  },
  {
    id: 'steward-historian',
    role: 'historian',
    name: 'dsh小助手 · 史官',
    description: '只记录不判断：按档位增量读会话，写带引用的言行录（发布默认开启；可切 sandbox 只读测试会话）。',
    order: 30,
  },
]

/**
 * 生成 `agentPresets.register` 需要的定义数组。
 * @param {{packageName?:string}} options
 */
export function presetDefinitions(options = {}) {
  const packageName = options.packageName || 'dsh-xiaozhushou'
  return ROLE_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    order: preset.order,
    plugins: [
      {
        name: `${packageName}/roles`,
        config: { role: preset.role },
      },
    ],
  }))
}
