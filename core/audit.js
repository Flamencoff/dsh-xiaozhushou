/**
 * 审计：只追加、永不改（13_项目总规则 / 18_详细设计 §3.6）。
 *
 * 写不进去不影响主功能——审计是旁路，不是前置条件。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = '审计.jsonl'
const MAX_BYTES = 20 * 1024 * 1024 // 超过就滚动一次（2026-10-26 补：以前只声明没实现，会无限增长）

export function createAudit(dataDir) {
  let broken = false
  let checkedAt = 0

  function rotateIfNeeded(file) {
    // 每 64 次写入检查一次大小，避免每次 stat 拖慢
    checkedAt += 1
    if (checkedAt % 64 !== 0) return
    try {
      if (!existsSync(file)) return
      if (statSync(file).size < MAX_BYTES) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(file, join(dataDir, `审计-${stamp}.jsonl`))
    } catch {
      /* 滚动失败不影响写 */
    }
  }

  function write(entry) {
    if (broken) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const file = join(dataDir, FILE_NAME)
      rotateIfNeeded(file)
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
      appendFileSync(file, line, { encoding: 'utf8' })
    } catch {
      broken = true
    }
  }

  return { write, maxBytes: MAX_BYTES }
}
