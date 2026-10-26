/**
 * 交接卡落盘（M4）：短卡 + 底账两层，写到 CEO 工作区
 *
 * 路径：`<dataDir 的上级>\CEO\交接卡\<日期>-<主题>.md`（短卡）
 *      `<dataDir 的上级>\CEO\交接卡\<日期>-<主题>.底账.md`（底账）
 *      `<dataDir 的上级>\CEO\交接卡\<日期>-<主题>-附件\<字段>.md`（超长内容全文）
 *
 * 纪律：
 *   · 不覆盖：同名已存在 → 递增编号；
 *   · 写不进去要报人话，不假装成功；
 *   · 短卡必须"短"：超过 60 行拒绝落盘（预览不拒）。
 *   · 超长内容不丢：截断进卡面，全文落到"附件"目录，卡面写明去哪找。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { handoverCard } from './analysis.js'

const MAX_CARD_LINES = 80
// 卡面里每个字段的长度上限（超出的部分不丢，落到附件）
const FIELD_LIMITS = { topic: 80, task: 500, changed: 300, progress: 300 }

const clip = (value, max) => {
  const text = String(value || '')
  return text.length > max ? text.slice(0, max) + '…' : text
}

export function createHandover({ dataDir }) {
  const root = join(dirname(dataDir), 'CEO', '交接卡')

  function targetNames(topic, date) {
    const safe = String(topic || '未命名任务').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40)
    return { base: `${date}-${safe}`, safe }
  }

  /** 找不重名的文件名（-01、-02…） */
  function uniquePath(dir, base, suffix) {
    let candidate = join(dir, base + suffix)
    let index = 1
    while (existsSync(candidate) && index < 100) {
      candidate = join(dir, `${base}-${String(index).padStart(2, '0')}${suffix}`)
      index += 1
    }
    return candidate
  }

  /**
   * @param {object} input 同 handoverCard 的入参；额外 `write` 决定是否落盘
   */
  function create(input = {}) {
    // 1) 找出超长字段：卡面截断，全文留到附件
    const attachments = []
    const prepared = { ...input }
    for (const key of ['topic', 'task', 'changed']) {
      const raw = String(input[key] || '')
      const max = FIELD_LIMITS[key] || 300
      if (raw.length > max) {
        attachments.push({ field: key, text: raw })
        prepared[key] = clip(raw, max) + `\n（全文 ${raw.length} 字，见同目录「附件」）`
      }
    }
    if (Array.isArray(input.progress)) {
      const joined = input.progress.map((item) => String(item)).join('\n')
      if (joined.length > FIELD_LIMITS.progress) {
        attachments.push({ field: 'progress', text: joined })
        prepared.progress = input.progress.slice(0, 5).map((item) => String(item).slice(0, 80))
      }
    }
    if (Array.isArray(input.unfinished)) {
      const joined = input.unfinished.map((item) => String(item)).join('\n')
      if (joined.length > FIELD_LIMITS.changed) {
        attachments.push({ field: 'unfinished', text: joined })
        prepared.unfinished = input.unfinished.slice(0, 5).map((item) => String(item).slice(0, 80))
      }
    }

    const built = handoverCard(prepared)
    if (!built.ok) return built

    const result = {
      ok: true,
      topic: built.topic,
      date: built.date,
      card: built.card,
      ledger: built.ledger,
      cardLines: built.card.split('\n').length,
      root,
      written: null,
      attachments: [],
    }

    // 2) 预览（write:false）不拦，只在落盘时拦
    if (result.cardLines > MAX_CARD_LINES && input.write) {
      return { ...result, ok: false, code: 'card_too_long', message: `短卡 ${result.cardLines} 行，超过 ${MAX_CARD_LINES} 行的上限，先精简再落盘` }
    }

    if (!input.write) return result

    try {
      mkdirSync(root, { recursive: true })
      const { base } = targetNames(built.topic, built.date)
      const cardPath = uniquePath(root, base, '.md')
      const ledgerPath = uniquePath(root, base, '.底账.md')

      // 3) 超长内容写附件（不丢东西），卡面追加"附件在哪"
      let card = built.card
      if (attachments.length) {
        const attachDir = cardPath.replace(/\.md$/, '') + '-附件'
        mkdirSync(attachDir, { recursive: true })
        const lines = ['', '## 附件（超长内容全文）']
        for (const item of attachments) {
          const file = join(attachDir, `${item.field}.md`)
          writeFileSync(file, item.text, 'utf8')
          lines.push(`- ${item.field}：${file}`)
          result.attachments.push({ field: item.field, path: file, chars: item.text.length })
        }
        card = card.trimEnd() + '\n' + lines.join('\n') + '\n'
      }

      writeFileSync(cardPath, card, 'utf8')
      writeFileSync(ledgerPath, built.ledger, 'utf8')
      return { ...result, card, cardLines: card.split('\n').length, written: { cardPath, ledgerPath } }
    } catch (error) {
      return { ...result, ok: false, code: 'write_failed', message: '交接卡写不进去：' + String(error && error.message ? error.message : error) }
    }
  }

  return { create, root }
}
