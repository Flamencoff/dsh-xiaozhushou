/**
 * 数据目录解析：不写死盘符，也不假设用户的工作区叫什么。
 *
 * 解析顺序（从稳到活）：
 *   1) 配置里显式写死的 dataDir（最优先，不写指针）；
 *   2) 上一次用过的目录（指针文件 ~/.dsh-session-steward/datadir.txt，
 *      兼容旧指针 ~/.dsh-xiaozhushou/datadir.txt，升级不丢数据）；
 *   3) 默认目录 ~/.dsh-session-steward/data（发布版默认，绝不在用户工作区里落数据）。
 *
 * 选完把结果写进指针文件，下次重启不会再漂。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const POINTER_DIR = '.dsh-session-steward'
const LEGACY_POINTER_DIR = '.dsh-xiaozhushou'
const POINTER_FILE = 'datadir.txt'
const DEFAULT_DIR_NAME = 'data'

export function pointerPath() {
  try {
    return join(homedir(), POINTER_DIR, POINTER_FILE)
  } catch {
    return null
  }
}

function readPointerFile(file) {
  try {
    if (!file || !existsSync(file)) return ''
    const text = readFileSync(file, 'utf8').trim()
    if (!text || !existsSync(text)) return ''
    // 防污染：测试/临时/依赖目录下的路径绝不能当数据目录
    if (!process.env.DSH_XIAOZHUSHOU_DATADIR_POINTER && /[\\/](\.tmp|node_modules|\.git)([\\/]|$)/i.test(text)) return ''
    return text
  } catch {
    return ''
  }
}

export function readPointer() {
  // 先读新指针，再兼容旧指针（旧版本升级上来的用户数据不丢）
  try {
    const current = readPointerFile(join(homedir(), POINTER_DIR, POINTER_FILE))
    if (current) return current
    return readPointerFile(join(homedir(), LEGACY_POINTER_DIR, POINTER_FILE))
  } catch {
    return ''
  }
}

export function writePointer(target) {
  try {
    if (!process.env.DSH_XIAOZHUSHOU_DATADIR_POINTER && /[\\/](\.tmp|node_modules|\.git)([\\/]|$)/i.test(String(target))) return false
    const file = pointerPath()
    if (!file) return false
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, String(target), 'utf8')
    return true
  } catch {
    return false
  }
}

export function defaultDataDir() {
  return join(homedir(), POINTER_DIR, DEFAULT_DIR_NAME)
}

export function resolveDataDir(ctx, config = {}) {
  const configured = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  // 配置里写了就是它说了算：不写指针（配置本身已经记住了，别用指针覆盖用户的显式选择）
  if (configured) {
    const target = resolve(configured)
    safeMkdir(target)
    return target
  }

  // 上次用过的（最稳）
  const remembered = readPointer()
  if (remembered) return remembered

  // 默认：用户主目录下，不落在任何工作区里
  const target = defaultDataDir()
  safeMkdir(target)
  writePointer(target)
  return target
}

function safeMkdir(target) {
  try {
    mkdirSync(target, { recursive: true })
  } catch {
    /* 目录建不了也不炸：调用方靠 isWritable 报告 */
  }
}
