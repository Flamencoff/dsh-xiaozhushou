/**
 * 把"已完成任务"加工成史官可投喂的格式（记忆卡）。
 *
 * 格式沿用作者既有投喂包体例：事实 / 可复用做法（候选偏好）/ 待核对，每条带来源。
 * 只写本地文件，不调模型、不直接改画像；史官读它再决定是否入库。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function stamp(now) {
  const d = now instanceof Date ? now : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    iso: d.toISOString(),
  }
}

/** 生成记忆卡文本（纯函数，便于测试） */
export function buildHistorianFeed(task, { now = new Date() } = {}) {
  const { date, iso } = stamp(now)
  const facts = String((task && task.facts) || '').trim()
  const title = String((task && task.title) || '').trim()
  const id = String((task && task.id) || '').trim()
  const lines = [
    `# 记忆投喂 · ${id} · ${title}`,
    '',
    `> 来源：任务板 ${id}（${String((task && task.by) || '?')} 指派，CEO 完成于 ${iso}）；由 CEO 在「存为记忆」时加工；供史官记录，不直接改规则。`,
    '',
    '## 一、事实',
    '',
    `- 任务：${title}`,
    `- 负责：${String((task && task.assignee) || '')}`,
    `- 完成时间：${iso}`,
  ]
  if (facts) lines.push(`- 事实底稿：${facts}`)
  lines.push(
    '',
    '## 二、可复用做法（候选偏好）',
    '',
    '- 待史官归纳：本条由 CEO 在任务完成时提交，未替史官下判断。',
    '',
    '## 三、待核对',
    '',
    '- 无',
    '',
    `（本卡生成日期：${date}）`,
    '',
  )
  return lines.join('\n')
}

/** 写入 <dataDir 上级>/史官/投喂/<日期>-<任务号>.md，返回相对路径信息 */
export function writeHistorianFeed({ dataDir, task, now = new Date() }) {
  const { date } = stamp(now)
  const root = join(dirname(String(dataDir)), '史官', '投喂')
  const file = join(root, `${date}-${String(task.id)}.md`)
  mkdirSync(root, { recursive: true })
  writeFileSync(file, buildHistorianFeed(task, { now }), 'utf8')
  return { file, dir: root }
}
