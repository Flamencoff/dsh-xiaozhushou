/**
 * 数据文件存取（18_详细设计 §3、§11）
 *
 * 约定：
 *   · 每个文件带 version；读的时候 version 高于当前 → 只读展示（不写坏）
 *   · 写入原子化（先写 .tmp 再 rename），断电不会留半个文件
 *   · 坏记录跳过并计数，交给看板显示"跳过了 N 条"（R-DAT-06）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const CURRENT_VERSION = 1

export function createStore(dataDir) {
  function pathOf(name) {
    return join(dataDir, name)
  }

  /** 读整个文件；任何异常都返回 fallback，并把原因挂到 store.lastError */
  function read(name, fallback) {
    try {
      const raw = readFileSync(pathOf(name), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.version === 'number' && parsed.version > CURRENT_VERSION) {
        store.lastError = `数据 ${name} 是新版本格式（v${parsed.version}），当前插件只认 v${CURRENT_VERSION}`
        store.readOnlyFiles.add(name)
        return { ...fallback, version: CURRENT_VERSION, readOnly: true }
      }
      // 2026-10-26 修：JSON "null" 是合法 JSON，但绝对不能让 null 流回调用方
      // （createLedger 会 file.items 抛 TypeError，插件整块加载失败）。非对象一律退回 fallback。
      // FIX-16：数组 / 没有已知字段的残片对象也当坏数据，备份后只读，别被下次写入覆盖
      // FIX-16：数组、或"只有 version 没有其它字段"的残片当坏数据（原来只挡 null）；
      // 正常文件（台账/游标/状态…）都有业务字段，不会被误判
      const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : []
      const looksBroken = Array.isArray(parsed) || (parsed && typeof parsed === 'object' && keys.length <= 1)
      if (looksBroken) {
        const backup = pathOf(name) + '.bad.' + new Date().toISOString().replace(/[:.]/g, '-')
        try { renameSync(pathOf(name), backup); store.lastError = `数据 ${name} 结构不对，已备份到 ${backup}，本次只读` } catch {}
        store.readOnlyFiles.add(name)
        return { ...fallback, corrupt: true, readOnly: true }
      }
      return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        // 2026-10-26 修 B-08：文件坏了（语法错）不能"当空数据接着用"——下一次写入会把
        // 用户的原始文件覆盖掉。这里先把坏文件备份成 .bad.<时间>，再标记 corrupt，
        // 由 ledger/inbox/cursor 拒绝写入（等用户修好或手工恢复）。
        const backup = pathOf(name) + '.bad.' + new Date().toISOString().replace(/[:.]/g, '-')
        try {
          renameSync(pathOf(name), backup)
          store.lastError = `数据 ${name} 解析失败，已备份到 ${backup}，本次只读（不覆盖你的原文件）`
        } catch {
          store.lastError = String(error.message || error)
        }
        store.lastErrorName = name
        return { ...fallback, corrupt: true, readOnly: true }
      }
      return fallback
    }
  }

  function write(name, data) {
    try {
      const target = pathOf(name)
      // 版本守卫：正在写的数据若是"新版本只读/损坏"状态，一律拒绝，避免覆盖
      if (store.readOnlyFiles && store.readOnlyFiles.has(name)) {
        store.lastError = `数据 ${name} 处于只读保护（新版本格式或已损坏），本次不覆盖`
        return false
      }
      mkdirSync(dirname(target), { recursive: true })
      const tmp = target + '.tmp'
      writeFileSync(tmp, JSON.stringify({ version: CURRENT_VERSION, ...data }, null, 2), 'utf8')
      renameSync(tmp, target)
      store.lastError = null // FIX-24：写成功后清降级，别一次失败永久标红
      return true
    } catch (error) {
      store.lastError = String(error && error.message ? error.message : error)
      return false
    }
  }

  // 2026-10-26 新增：纯文本追加/读取（台账归档用；不走 JSON）
  function appendText(name, text) {
    try {
      const target = pathOf(name)
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, text, { encoding: 'utf8' })
      return true
    } catch (error) {
      store.lastError = String(error && error.message ? error.message : error)
      return false
    }
  }

  function readText(name) {
    try {
      return readFileSync(pathOf(name), 'utf8')
    } catch {
      return ''
    }
  }

  function exists(name) {
    try {
      return existsSync(pathOf(name))
    } catch {
      return false
    }
  }

  const store = { dataDir, read, write, appendText, readText, exists, lastError: null, lastErrorName: null, readOnlyFiles: new Set() }
  return store
}
