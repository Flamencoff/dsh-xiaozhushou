#!/usr/bin/env node
/**
 * 发布自检：分支合并前与打 tag 前必须全绿。
 * 零依赖，只用 node: 内置模块；检查失败以非零码退出。
 *
 * 检查项：
 *   1) 包元数据完整（name/version/license/engines.dsh/files/exports/dsh）
 *   2) 版本号单一来源（package.json = index.js VERSION）
 *   3) 运行必需文件齐全
 *   4) 发布配置正确（史官默认开启、scope.mode=all）
 *   5) 不出现个人痕迹、密钥、运行数据与旧内部包名
 *   6) npm 包体积与单文件体积
 *   7) README / LICENSE / CHANGELOG / 第三方声明
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const fail = (message) => problems.push(message)

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

function walk(dir, out = [], relBase = '') {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', '.tmp', '.tmp-home', 'dist'].includes(name)) continue
    const full = join(dir, name)
    const rel = relBase ? `${relBase}/${name}` : name
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out, rel)
    else out.push(rel)
  }
  return out
}

/* 1) 包元数据 */
let pkg
try {
  pkg = JSON.parse(read('package.json'))
} catch (error) {
  console.error('package.json 解析失败：' + error.message)
  process.exit(1)
}
if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(pkg.name)) fail('package.name 不是合法 npm 包名：' + pkg.name)
if (pkg.private === true) fail('package.json 不能 private:true（发布版要能 npm publish）')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail('package.version 不是 SemVer：' + pkg.version)
if (pkg.license !== 'MIT') fail('package.license 必须是 MIT')
if (!pkg.engines || !pkg.engines.node) fail('package.engines.node 缺失')
if (!pkg.engines || !pkg.engines.dsh) fail('package.engines.dsh 缺失（安装与市场兼容性都靠它）')
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) fail('package.dsh.bundle.patch 缺失')
if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') fail('package.dsh.client.platform 必须是 web')
if (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject && !Array.isArray(pkg.dsh.client.inject)) fail('package.dsh.client.inject 必须是数组')
for (const key of ['.', './client', './roles', './icon']) {
  if (!pkg.exports || !pkg.exports[key]) fail('package.exports 缺 ' + key)
}
if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail('package.files 缺失')
if (pkg.files && pkg.files.includes('test')) fail('package.files 不应包含 test（测试留在仓库，不进 npm 包）')

/* 2) 版本单一来源 */
const indexSrc = read('index.js')
const versionMatch = /const VERSION = '([^']+)'/.exec(indexSrc)
if (!versionMatch) fail('index.js 里找不到 const VERSION')
else if (versionMatch[1] !== pkg.version) fail(`版本不一致：package.json=${pkg.version}，index.js VERSION=${versionMatch[1]}`)

/* 3) 运行必需文件 */
const required = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'roles/index.js',
  'roles/presets.js',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'assets/whale-placeholder.svg',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'docs/RELEASE.md',
  'docs/PRIVACY.md',
]
for (const rel of required) if (!existsSync(join(root, rel))) fail('缺少必需文件：' + rel)
const coreFiles = existsSync(join(root, 'core')) ? readdirSync(join(root, 'core')).filter((n) => n.endsWith('.js')) : []
if (coreFiles.length < 10) fail('core/ 模块数量异常：' + coreFiles.length)

/* 4) 发布配置（0.47.0 · 框架 v2 D-05/06：史官默认开启 + 读取范围 all） */
const patch = read('cordis.patch.yml')
if (!patch.includes("name: 'dsh-xiaozhushou'")) fail('cordis.patch.yml 未引用 dsh-xiaozhushou')
if (!/historian:\s*true/.test(patch)) fail('cordis.patch.yml 发布默认必须开启史官（historian: true）')
if (!/mode:\s*all/.test(patch)) fail('cordis.patch.yml 发布默认读取范围必须是 all（sandbox 只给开发测试本地用，不要提交）')
if (!/prefixes:/.test(patch)) fail('cordis.patch.yml 必须保留 sandbox 前缀（方便切回只读测试会话）')

/* 5) 个人痕迹 / 密钥 / 数据 / 旧包名 */
const forbidden = [
  { re: /袁志晓|程运航|纪检|智冀廉|包有为|reasonix/iu, why: '个人身份或旧项目名' },
  { re: /D:[\\/]aiagent|dshwork/iu, why: '本机路径' },
  { re: /session-[0-9a-f]{8}-[0-9a-f]{4}/u, why: '会话 id' },
  { re: /sk-[A-Za-z0-9]{12,}/u, why: '疑似 API Key' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/u, why: '疑似 GitHub token' },
  { re: /AKIA[0-9A-Z]{16}/u, why: '疑似云密钥' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, why: '私钥' },
  { re: /@local\//u, why: '旧内部包名' },
]
const textExts = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.txt', '.ps1', '.html', '.css'])
const dataNames = new Set(['待办.json', '任务.json', '审计.jsonl', '采集.json', '看板.json', '状态.json', '提醒状态.json', '推送状态.json', '归档状态.json'])
const files = walk(root)
for (const rel of files) {
  const name = rel.split('/').pop()
  if (dataNames.has(name)) fail('仓库里不应出现运行数据文件：' + rel)
  if (!textExts.has(extname(name).toLowerCase())) continue
  if (rel === 'scripts/check-release.mjs') continue // 本文件自身包含检查词
  if (rel === 'core/paths.js') continue // 兼容旧指针的常量，允许出现旧名
  const text = readFileSync(join(root, rel), 'utf8')
  for (const rule of forbidden) {
    if (rule.re.test(text)) fail(`${rel} 含${rule.why}：${String(text.match(rule.re)[0]).slice(0, 40)}`)
  }
}

/* 6) 发布体积（只算 package.files 覆盖的文件） */
function fileIncluded(rel) {
  return (pkg.files || []).some((entry) => {
    if (entry.endsWith('/')) return rel.startsWith(entry)
    if (entry.includes('*')) {
      const re = new RegExp('^' + entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      return re.test(rel)
    }
    return rel === entry || rel.startsWith(entry + '/')
  })
}
let total = 0
let biggest = { rel: '', size: 0 }
for (const rel of files) {
  if (!fileIncluded(rel)) continue
  const size = statSync(join(root, rel)).size
  total += size
  if (size > biggest.size) biggest = { rel, size }
}
if (total > 1024 * 1024) fail(`npm 包体积应 < 1MiB，实际 ${(total / 1024).toFixed(0)}KiB`)
if (biggest.size > 256 * 1024) fail(`单文件应 < 256KiB，最大 ${biggest.rel} = ${(biggest.size / 1024).toFixed(0)}KiB`)

/* 7) 对外文档 */
const readme = read('README.md')
for (const token of ['dsh plugin --profile', 'dsh-xiaozhushou', 'plugin_manager', 'MIT', 'dsh-plugin']) {
  if (!readme.includes(token)) fail('README.md 缺少市场收录必需内容：' + token)
}
const license = read('LICENSE')
if (!license.includes('MIT License')) fail('LICENSE 不是 MIT')
if (!license.includes('flamencoff')) fail('LICENSE 缺少版权署名 flamencoff')
const changelog = read('CHANGELOG.md')
if (!changelog.includes(pkg.version)) fail('CHANGELOG.md 没写当前版本 ' + pkg.version)
const third = read('THIRD_PARTY_NOTICES.md')
if (!third.includes('零第三方 npm 依赖')) fail('THIRD_PARTY_NOTICES.md 必须声明零第三方 npm 依赖')

if (problems.length) {
  console.error(`发布自检失败（${problems.length} 项）：`)
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}
console.log(`发布自检通过：${pkg.name}@${pkg.version}，${coreFiles.length} 个 core 模块，npm 包 ${(total / 1024).toFixed(0)}KiB，最大文件 ${biggest.rel} ${(biggest.size / 1024).toFixed(0)}KiB`)
