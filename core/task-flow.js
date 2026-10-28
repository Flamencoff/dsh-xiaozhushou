/**
 * 任务产物链：交接卡 → 执行结果 → 秘书归档。
 *
 * 只写数据目录内的普通 Markdown/JSON 引用，不调模型；任务本体仍以 任务.json 为准。
 * 史官投喂卡由 core/historian-feed.js 另写（沿用作者既有投喂体例）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function day(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
}

function uniquePath(file) {
  if (!existsSync(file)) return file
  const ext = /\.[^.]+$/.exec(file)
  const base = ext ? file.slice(0, -ext[0].length) : file
  const suffix = ext ? ext[0] : ''
  for (let i = 2; i < 1000; i += 1) {
    const next = base + '-' + i + suffix
    if (!existsSync(next)) return next
  }
  return base + '-' + Date.now() + suffix
}

function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return day(now) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
}

export function createTaskFlow({ dataDir }) {
  const root = String(dataDir || '')
  if (!root) throw new Error('task-flow: dataDir required')
  const dirs = {
    handoff: join(root, 'CEO', '交接卡'),
    result: join(root, 'CEO', '结果'),
    archive: join(root, '秘书', '归档'),
  }

  function taskIdOf(task) {
    const id = String((task && task.id) || '').trim()
    return /^K-\d{2,}$/i.test(id) ? id.toUpperCase() : ''
  }

  function writeHandoff({ task, sessionId = '' } = {}) {
    const id = taskIdOf(task)
    if (!id) return { ok: false, code: 'bad_task_id', message: '任务号不合法' }
    const now = new Date()
    const text = [
      '# 交接卡 · ' + id + ' · ' + String(task.title || ''),
      '',
      '> 来源：' + String(task.by || '?') + ' 指派；状态：' + String(task.status || '') + '；生成时间：' + stamp(now),
      '',
      '## 任务',
      '',
      '- ' + String(task.title || ''),
      '',
      '## 背景与事实底稿',
      '',
      String(task.facts || '（没有额外事实底稿）').trim() || '（没有额外事实底稿）',
      '',
      '## 执行会话',
      '',
      sessionId ? '- 会话：' + sessionId : '- 还没开执行会话',
      '',
      '## 边界',
      '',
      '- 只处理这条任务，不擅自扩大范围；需要权限时在会话里向作者申请。',
      '- 涉及隐私/密钥/他人内容一律排除。',
      '',
      '## 交付物与验收',
      '',
      '- 交付物：结论 + 产出文件路径（如有）。',
      '- 验收：作者能复述结论、找到产出、知道遗留问题。',
      '',
      '## 完成后',
      '',
      '- 在任务板点「完成」，把结果写进「结果」文件；再由秘书归档、史官记忆。',
      '',
    ].join('\n')
    try {
      mkdirSync(dirs.handoff, { recursive: true })
      const file = join(dirs.handoff, id + '.md')
      writeFileSync(file, text, 'utf8')
      return { ok: true, path: file, dir: dirs.handoff }
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '交接卡写不进去：' + String(error && error.message ? error.message : error) }
    }
  }

  function writeResult({ task, result = '' } = {}) {
    const id = taskIdOf(task)
    if (!id) return { ok: false, code: 'bad_task_id', message: '任务号不合法' }
    const now = new Date()
    const body = String(result || '').trim()
    const text = [
      '# 执行结果 · ' + id + ' · ' + String(task.title || ''),
      '',
      '> 完成时间：' + stamp(now) + '；执行会话：' + String(task.sessionId || task.session || '（未记录）'),
      '',
      '## 结论 / 产出',
      '',
      body || '（完成时没有填写结果摘要）',
      '',
      '## 交接卡',
      '',
      task.handoffCard ? '- ' + task.handoffCard : '- （没有交接卡）',
      '',
      '## 遗留',
      '',
      '- 待作者确认：无 / 见上',
      '',
    ].join('\n')
    try {
      mkdirSync(dirs.result, { recursive: true })
      const file = uniquePath(join(dirs.result, id + '.md'))
      writeFileSync(file, text, 'utf8')
      return { ok: true, path: file, dir: dirs.result }
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '结果文件写不进去：' + String(error && error.message ? error.message : error) }
    }
  }

  function writeArchive({ task } = {}) {
    const id = taskIdOf(task)
    if (!id) return { ok: false, code: 'bad_task_id', message: '任务号不合法' }
    const now = new Date()
    const folder = join(dirs.archive, day(now))
    const text = [
      '# 归档 · ' + id + ' · ' + String(task.title || ''),
      '',
      '> 归档时间：' + stamp(now) + '；原负责人：' + String(task.assignee || '') + '；状态：' + String(task.status || ''),
      '',
      '## 链接',
      '',
      '- 交接卡：' + (task.handoffCard || '（无）'),
      '- 执行结果：' + (task.resultPath || '（无）'),
      '- 执行会话：' + (task.sessionId || '（无）'),
      '',
      '## 摘要',
      '',
      String(task.resultSummary || '（没有结果摘要）').trim() || '（没有结果摘要）',
      '',
      '## 史官',
      '',
      '- 记忆卡：' + (task.memoryPath || '（还没生成）'),
      '',
    ].join('\n')
    try {
      mkdirSync(folder, { recursive: true })
      const file = uniquePath(join(folder, id + '.md'))
      writeFileSync(file, text, 'utf8')
      return { ok: true, path: file, dir: folder }
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '归档文件写不进去：' + String(error && error.message ? error.message : error) }
    }
  }

  return { dirs, writeHandoff, writeResult, writeArchive }
}

export { day as taskDay, stamp as taskStamp }
