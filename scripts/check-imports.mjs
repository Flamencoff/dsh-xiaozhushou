#!/usr/bin/env node
/**
 * 模块依赖体检：为"每个模块可独立修改"兜底。
 * 零依赖，只用 node: 内置模块；违规以非零码退出。
 *
 * 规则：
 *   R1 不允许循环依赖；
 *   R2 宿主半只允许 import node: 内置模块与包内相对路径；
 *   R3 依赖方向单向：index.js → core / roles，core 不得反向 import 入口、客户端或 roles；
 *   R4 不允许多余/悬空的相对 import（写错路径会在这里暴露）。
 * 输出：每个模块的行数、出度、被引用次数；超过 800 行或无人引用的模块给 warning。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const warnings = []

function hostFiles() {
  const files = ['index.js']
  for (const dir of ['core', 'roles']) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    for (const name of readdirSync(full)) {
      if (extname(name) === '.js') files.push(`${dir}/${name}`)
    }
  }
  return files
}

const IMPORT_RE = /(?:^|[^\w.])import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gu
const files = hostFiles()
const deps = new Map()
for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8')
  const list = []
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1] || match[2]
    if (!spec) continue
    if (spec.startsWith('node:')) continue
    if (!spec.startsWith('.')) {
      errors.push(`${rel} 引用了非 node: 外部模块 "${spec}"（宿主半必须零依赖）`)
      continue
    }
    const target = resolve(dirname(join(root, rel)), spec)
    const targetRel = relative(root, target).replaceAll('\\', '/')
    if (!existsSync(target) && !existsSync(target + '.js') && !existsSync(target + '/index.js')) {
      errors.push(`${rel} 的相对 import 指向不存在的文件：${spec}`)
      continue
    }
    list.push(targetRel.endsWith('.js') ? targetRel : targetRel + '.js')
  }
  deps.set(rel, list)
}

// R3 方向规则
for (const [rel, list] of deps) {
  const isCore = rel.startsWith('core/')
  const isRoles = rel.startsWith('roles/')
  for (const dep of list) {
    if (isCore && (dep === 'index.js' || dep === 'client.js' || dep.startsWith('roles/'))) {
      errors.push(`依赖方向违规：${rel} → ${dep}（core 不能依赖入口/客户端/roles）`)
    }
    if (isRoles && (dep === 'index.js' || dep === 'client.js')) {
      errors.push(`依赖方向违规：${rel} → ${dep}（roles 不能依赖入口/客户端）`)
    }
  }
}

// R1 循环依赖
const state = new Map()
const stack = []
function visit(node) {
  if (state.get(node) === 'done') return
  if (state.get(node) === 'visiting') {
    const cycle = stack.slice(stack.indexOf(node)).concat(node)
    errors.push('循环依赖：' + cycle.join(' → '))
    return
  }
  state.set(node, 'visiting')
  stack.push(node)
  for (const dep of deps.get(node) || []) if (deps.has(dep)) visit(dep)
  stack.pop()
  state.set(node, 'done')
}
for (const node of files) visit(node)

// 统计
const fanIn = new Map(files.map((rel) => [rel, 0]))
for (const [, list] of deps) for (const dep of list) if (fanIn.has(dep)) fanIn.set(dep, fanIn.get(dep) + 1)
const rows = []
for (const rel of files) {
  const lines = readFileSync(join(root, rel), 'utf8').split('\n').length
  const out = (deps.get(rel) || []).length
  const inn = fanIn.get(rel) || 0
  rows.push({ rel, lines, out, inn })
  if (lines > 800) warnings.push(`${rel} 有 ${lines} 行，建议按模块拆分（目标 < 800 行）`)
  if (inn === 0 && rel !== 'index.js' && rel !== 'roles/index.js') warnings.push(`${rel} 没有被任何宿主模块引用（可能是死代码）`)
}
rows.sort((a, b) => b.lines - a.lines)
console.log('模块依赖体检：')
for (const row of rows.slice(0, 12)) console.log(`  ${String(row.lines).padStart(5)} 行  出${row.out} 入${row.inn}  ${row.rel}`)
if (warnings.length) {
  console.log('\nwarning：')
  for (const w of warnings) console.log('  - ' + w)
}
if (errors.length) {
  console.error(`\n依赖体检失败（${errors.length} 项）：`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log(`\n依赖体检通过：${rows.length} 个宿主模块，无循环依赖、无外部依赖、方向正确`)
