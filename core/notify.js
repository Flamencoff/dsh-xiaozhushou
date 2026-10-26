/**
 * CEO → 秘书的极简备案（R-ROL-09，01 §六.2）
 *
 * 用户定过：CEO 与用户每次交互后，自动给秘书留一条极简备案
 * （时间 / 主题 / 结论 / 待办 / 涉及会话 id），只存结构化短字段，不复制长文。
 *
 * 落盘：`<dataDir>/备忘/秘书备案.jsonl`（只追加）；另外维护一份人读的
 *       `<dataDir>/备忘/秘书备案.md` 尾巴（最近 20 条），方便直接翻。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '备忘'
const JSONL = '秘书备案.jsonl'
const MD = '秘书备案.md'
const MD_TAIL = 20

export function createNotifier({ dataDir }) {
  const root = join(dataDir, DIR)

  /**
   * @param {{at?:string, topic:string, conclusion:string, todo?:string[], sessionId?:string, role?:string}} entry
   */
  function write(entry) {
    const at = entry && entry.at ? String(entry.at) : new Date().toISOString()
    const topic = clip(entry && entry.topic, 40)
    const conclusion = clip(entry && entry.conclusion, 60)
    if (!topic || !conclusion) return { ok: false, code: 'empty_notice', message: '备案至少要写清主题和结论' }

    const record = {
      at,
      role: (entry && entry.role) || 'ceo',
      topic,
      conclusion,
      todo: Array.isArray(entry && entry.todo) ? entry.todo.slice(0, 5).map((item) => clip(item, 40)) : [],
      sessionId: (entry && entry.sessionId) || null,
    }

    try {
      mkdirSync(root, { recursive: true })
      appendFileSync(join(root, JSONL), JSON.stringify(record) + '\n', 'utf8')
      refreshMarkdown(root)
      return { ok: true, record }
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '备案写不进去：' + String(error && error.message ? error.message : error) }
    }
  }

  function refreshMarkdown(dir) {
    const file = join(dir, JSONL)
    let lines = []
    try {
      lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return
    }
    const tail = lines.slice(-MD_TAIL).map((line) => {
      try {
        const item = JSON.parse(line)
        // 2026-10-26 修 B-10：备案里的人读时间以前是 UTC（差 8 小时），改成按本地时区显示
        const clock = localClock(item.at)
        const todos = item.todo && item.todo.length ? `；待办：${item.todo.join('、')}` : ''
        const session = item.sessionId ? `；会话：${item.sessionId}` : ''
        return `- ${clock} 【${item.role}】${item.topic}：${item.conclusion}${todos}${session}`
      } catch {
        return null
      }
    }).filter(Boolean)

    const content = ['# 秘书备案（最近 ' + MD_TAIL + ' 条）', '', '> CEO 与用户每次交互后自动留的极简备案；只存短字段，不复制长文。', '', ...tail, ''].join('\n')
    try {
      writeFileSync(join(dir, MD), content, 'utf8')
    } catch {
      /* 人读版写失败不影响 jsonl */
    }
  }

  function recent(limit = 10) {
    try {
      const lines = readFileSync(join(root, JSONL), 'utf8').trim().split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, limit)).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)
    } catch {
      return []
    }
  }

  return { write, recent, root }
}

function localClock(iso) {
  try {
    const d = new Date(String(iso || ''))
    if (Number.isNaN(d.getTime())) return String(iso || '').slice(11, 16)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  } catch {
    return String(iso || '').slice(11, 16)
  }
}

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max) + '…'
}
