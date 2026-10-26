/**
 * 找文件（R-SCE-12；旧资料里用户反复要过"帮我在电脑里找找我的 XX 报告"）
 *
 * 安全边界（比功能更重要）：
 *   1) 只允许在**白名单根目录**里搜：默认是数据目录的上一级，可加 allowedRoots；
 *   2) 拒绝越界（`..`、绝对路径逃逸、符号链接逃逸）；
 *   3) 跳过 node_modules/.git/缓存目录与大文件（>2MB）、二进制扩展名；
 *   4) 结果有上限、有超时，不把机器拖死；
 *   5) 只读：绝不修改、绝不删除。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', '__pycache__', '.idea', '.vscode', 'dist', '.tmp', '史官', 'CEO'])
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.py', '.csv', '.log', '.html', '.css', '.xml'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

export function createFinder({ config, dataDir, log }) {
  const allowedRoots = buildRoots(config, dataDir)
  const logger = typeof log === 'function' ? log : () => {}

  /**
   * @param {{query:string, root?:string, limit?:number, maxDepth?:number, content?:boolean, timeoutMs?:number}} request
   */
  function find(request) {
    const query = String((request && request.query) || '').trim()
    if (!query) return { ok: false, code: 'empty_query', message: '要找什么？给个关键词（文件名或内容都行）' }

    const root = request && request.root ? resolve(String(request.root)) : allowedRoots[0]
    if (!root) return { ok: false, code: 'no_root', message: '没有可搜的根目录' }
    if (!isAllowed(root)) {
      return {
        ok: false,
        code: 'root_not_allowed',
        message: `只在允许的目录里找：${allowedRoots.join('、')}`,
      }
    }

    const limit = clampInt(request && request.limit, 1, 50, 20)
    const maxDepth = clampInt(request && request.maxDepth, 1, 10, 6)
    // 内容检索默认关闭（只按文件名找）；要搜内容用 content:true 或配置 find.content:true
  // 或在配置里 find.content:true。以前默认就全文搜整个工作区，和'不碰材料原件'的口径相反。
  const searchContent = request && typeof request.content === 'boolean'
    ? request.content
    : Boolean(config && config.find && config.find.content === true)
    const deadline = Date.now() + clampInt(request && request.timeoutMs, 500, 20000, 6000)
    const lower = query.toLowerCase()

    const hits = []
    let scanned = 0
    let timedOut = false

    // BFS：浅层优先。DFS 会先扎进几千个文件的学习笔记库，
    // 6 秒预算耗尽后，工作区根目录下明明存在的文件反而找不到。
    const queue = [{ dir: root, depth: 0 }]
    while (queue.length) {
      if (hits.length >= limit || Date.now() > deadline) {
        if (Date.now() > deadline) timedOut = true
        break
      }
      const current = queue.shift()
      let entries
      try {
        entries = readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (hits.length >= limit || Date.now() > deadline) {
          if (Date.now() > deadline) timedOut = true
          break
        }
        if (entry.name.startsWith('.')) continue
        const full = join(current.dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || current.depth >= maxDepth) continue
          queue.push({ dir: full, depth: current.depth + 1 })
          continue
        }
        scanned += 1
        const nameHit = entry.name.toLowerCase().includes(lower)
        let snippet = ''
        let hitKind = nameHit ? 'name' : ''
        if (!nameHit && searchContent) {
          const ext = extOf(entry.name)
          if (!TEXT_EXT.has(ext)) continue
          try {
            if (statSync(full).size > MAX_FILE_BYTES) continue
            const text = readFileSync(full, 'utf8')
            const index = text.toLowerCase().indexOf(lower)
            if (index >= 0) {
              hitKind = 'content'
              snippet = text.slice(Math.max(0, index - 30), Math.min(text.length, index + lower.length + 50)).replace(/\s+/g, ' ')
            }
          } catch {
            continue
          }
        }
        if (hitKind) {
          hits.push({
            path: full,
            name: entry.name,
            relative: full.startsWith(root) ? full.slice(root.length + 1) : full,
            hit: hitKind,
            snippet: snippet.slice(0, 120),
          })
        }
      }
    }

    return {
      ok: true,
      root,
      query,
      hits,
      scanned,
      timedOut,
      truncated: hits.length >= limit,
      message: hits.length
        ? `找到 ${hits.length} 个` + (timedOut ? '（时间到，可能没找全）' : '')
        : (timedOut ? '时间到还没扫完（可能没找全）：换个更准的关键词，或缩小目录再试' : '没找到；换个关键词试试'),
    }
  }

  function isAllowed(target) {
    const normalized = resolve(target)
    return allowedRoots.some((root) => normalized === root || normalized.startsWith(root + sep))
  }

  return { find, allowedRoots, isAllowed }
}

function buildRoots(config, dataDir) {
  const roots = []
  const push = (value) => {
    if (!value) return
    try {
      const abs = resolve(String(value))
      if (!roots.includes(abs)) roots.push(abs)
    } catch {
      /* 非法路径忽略 */
    }
  }
  const configured = config && config.find && Array.isArray(config.find.allowedRoots) ? config.find.allowedRoots : []
  if (configured.length) {
    // 2026-10-26 修 A-07：配了白名单就以白名单为准（替换默认根），否则用户没法把搜索收窄
    for (const item of configured) push(item)
  } else {
    push(dataDir ? join(dataDir, '..') : '')
  }
  return roots
}

function extOf(name) {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLowerCase()
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
