#!/usr/bin/env node
/**
 * 生成 DSH 官方"自定义插件市场"索引（format 1）。
 *
 * 用法（先推 GitHub，再在本仓库跑）：
 *   node scripts/build-market-index.mjs                 # 用当前 HEAD 作为版本提交
 *   node scripts/build-market-index.mjs --commit <sha>  # 指定 40 位 commit
 *   node scripts/build-market-index.mjs --out dist/market-index.json
 *
 * 产物放到 GitHub Pages / 任意 https 静态地址后，用户在 DSH 设置 → 插件市场里
 * 添加这个 index.json 的 URL 即可搜索安装。索引格式依据随 DSH 发布的
 * @deepseek-ai/dsh-plugin-market-index（format 1）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repositoryUrl = String(pkg.repository && pkg.repository.url ? pkg.repository.url : '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
if (!/^https:\/\/[^/]+(?:\/[^/]+){2,}$/.test(repositoryUrl)) {
  console.error('package.json 的 repository.url 不是可发布的 https 仓库地址：' + repositoryUrl)
  process.exit(1)
}

let commit = argValue('--commit', '')
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    console.error('拿不到当前 commit，请先 git init/commit，或用 --commit <40位sha> 指定')
    process.exit(1)
  }
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('commit 必须是 40 位小写 sha：' + commit)
  process.exit(1)
}

const iconSvg = readFileSync(join(root, 'icon.svg'))
const icon = 'data:image/svg+xml;base64,' + iconSvg.toString('base64')
if (icon.length / 4 * 3 > 32 * 1024) {
  console.error('icon.svg 超过 32KiB 上限，无法内联进市场索引')
  process.exit(1)
}

const publishTimestamp = Number(argValue('--publish-timestamp', String(Math.floor(Date.now() / 1000))))
if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0) {
  console.error('publishTimestamp 必须是 Unix 秒（整数）')
  process.exit(1)
}

const index = {
  format: 1,
  title: { zh: 'dsh小助手', en: 'dsh-xiaozhushou' },
  description: {
    zh: '秘书 / CEO / 史官 三角色助手，带本地待办台账、定点提醒、共享任务板与看板娘浮窗。',
    en: 'Secretary / CEO / Historian assistant with a local todo ledger, reminders, a shared task board, and a mascot overlay.',
  },
  metadata: {
    categories: {
      assistant: { title: { zh: '助手与效率', en: 'Assistant & Productivity' } },
    },
    labels: {
      chinese: { title: { zh: '中文界面', en: 'Chinese UI' } },
      local: { title: { zh: '本地优先', en: 'Local-first' } },
    },
    sortKeys: {
      stars: { title: { zh: '收藏', en: 'Stars' }, order: 'desc' },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { zh: 'dsh小助手', en: 'dsh-xiaozhushou' },
      description: {
        zh: '三个角色（秘书 / CEO / 史官）+ 待办台账 + 定点提醒 + 看板娘。数据全在本地，史官默认只读测试会话。',
        en: 'Three roles (secretary / CEO / historian) with a local todo ledger, reminders, and a mascot. All data stays local; the historian only reads sandbox sessions by default.',
      },
      icon,
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: repositoryUrl },
      metadata: {
        category: 'assistant',
        keywords: pkg.keywords,
        labels: ['chinese', 'local'],
        sortKeys: { stars: 0 },
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: {
            type: 'git',
            url: repositoryUrl + '.git',
            commit,
          },
          engines: pkg.engines && pkg.engines.dsh ? { dsh: pkg.engines.dsh } : {},
        },
      ],
    },
  ],
}

/* 自校验：与 format 1 的关键规则保持一致，避免生成一个市场读不了的索引 */
const errors = []
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (index.format !== 1) errors.push('format 必须是 1')
if (!index.plugins.length) errors.push('plugins 不能为空')
for (const plugin of index.plugins) {
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(plugin.name)) errors.push('包名不合法：' + plugin.name)
  if (!plugin.versions.length) errors.push(plugin.name + ' 没有版本')
  for (const version of plugin.versions) {
    if (!semver.test(version.version)) errors.push('版本号不合法：' + version.version)
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp <= 0) errors.push('publishTimestamp 不合法')
    if (version.source.type === 'git') {
      if (!/^https:\/\/[^/]+(?:\/[^/]+){2,}$/.test(version.source.url)) errors.push('git source url 不合法')
      if (!/^[0-9a-f]{40}$/.test(version.source.commit)) errors.push('git commit 必须是 40 位小写 sha')
    }
  }
}
if (errors.length) {
  console.error('市场索引自校验失败：')
  for (const error of errors) console.error(' - ' + error)
  process.exit(1)
}

const out = resolve(root, argValue('--out', 'dist/market-index.json'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`市场索引已生成：${out}`)
console.log(`  插件：${pkg.name}@${pkg.version}  提交：${commit.slice(0, 12)}`)
console.log('  下一步：把 dist/market-index.json 发布到 https 静态地址（如 GitHub Pages），')
console.log('  再在 DSH「设置 → 插件市场」添加该 URL；GitHub 公开仓库+topic dsh-plugin 的收录走 dsh-plugin.org。')
void existsSync
