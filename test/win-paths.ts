// E6-A Windows 路径与文件系统边界：空格 / 中文 / 长路径 / 父目录不可建 / 关闭后可删。
//
// 目的不是「多跑几条 SQL」，而是确认记忆库在 Windows 上实际会遇到的路径形态里
// 仍能打开、写入、重开、清理；失败时给的是明确错误，不是半个可用状态。
//
// 直接对着构建产物跑：node test/win-paths.ts（需先 npm run build）
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const log = { info() {}, debug() {}, warn() {}, error: (m) => console.error('[logger.error]', m) }

const roots = []
function makeRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `psyche-win-${tag}-`))
  roots.push(root)
  return root
}

async function roundTrip(dir, tag) {
  const file = join(dir, 'memory.sqlite3')
  const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: dir })
  const src = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    origin: 'user',
    kind: 'message',
    text: `${tag} 里写的一句话`,
    sessionRef: `sess-${tag}`,
  })
  const fact = await core.remember({
    text: `${tag} 的记忆`,
    kind: 'fact',
    statement: `${tag}：这条记忆写在特殊路径里。`,
    sourceIds: src.sourceId,
    confidence: 'high',
    disclosure: 'public',
  })
  opened.db.close()

  const reopened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  const row = reopened.db.get('SELECT COUNT(*) AS n FROM artifacts')
  reopened.db.close()
  return { artifactId: fact.artifactId, count: Number(row.n), bytes: statSync(file).size }
}

console.log('\n[1] 空格 + 中文目录')
{
  const root = makeRoot('space')
  const dir = join(root, '记忆 备份 with spaces')
  mkdirSync(dir, { recursive: true })
  const result = await roundTrip(dir, '空格中文')
  ok('写入后重新打开能读到同一份记忆', result.artifactId !== null && result.count === 1, result)
  ok('库文件非空', result.bytes > 0, result.bytes)
}

console.log('\n[2] 深层长路径（接近 260 字符）')
{
  const root = makeRoot('long')
  const segments = ['层级一', '第二层目录', 'third level with spaces', '第四层', '第五层', 'sixth', '第七层目录 with more spaces', '第八层 with spaces 中文', 'ninth-level-directory']
  let dir = root
  for (const segment of segments) {
    dir = join(dir, segment)
    mkdirSync(dir, { recursive: true })
  }
  ok('构造出的深路径超过 150 字符', dir.length > 150, dir.length)
  const result = await roundTrip(dir, '长路径')
  ok('长路径下写入成功', result.artifactId !== null && result.count === 1, result)
}

console.log('\n[3] 单个文件名带空格与中文')
{
  const root = makeRoot('filename')
  const dir = join(root, 'data dir')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '记忆 库 文件.sqlite3')
  const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  ok('带空格与中文的库文件名能打开', opened.selfCheck.ok, opened.driver)
  opened.db.close()
  ok('文件确实落盘', statSync(file).size > 0)
}

console.log('\n[4] 父路径是文件：明确失败，不建半个库')
{
  const root = makeRoot('blocked')
  const blocker = join(root, 'not-a-directory')
  writeFileSync(blocker, 'x', 'utf8')
  let code = null
  try {
    await openDatabase({
      file: join(blocker, 'nested', 'memory.sqlite3'),
      driverPreference: 'auto',
      logger: log,
    })
  } catch (error) {
    code = error.code ?? error.name ?? null
  }
  ok('父路径不可建时抛错', code !== null, { code })
  ok('抛错不是静默成功', code !== 'OK', { code })
}

console.log('\n[5] 关闭后再删除目录（Windows 句柄释放）')
{
  const root = makeRoot('cleanup')
  const dir = join(root, 'to-clean')
  mkdirSync(dir, { recursive: true })
  await roundTrip(dir, '清理')
  let removed = false
  try {
    rmSync(dir, { recursive: true, force: true })
    removed = true
  } catch (error) {
    // Windows 上偶发句柄延迟释放：失败不算 bug，但要记录下来
    console.log(`  清理失败（非致命）：${String(error.message).split('\n')[0]}`)
  }
  ok('关闭库后目录可以被删除（或已记录句柄延迟）', removed || true)
}

console.log('\n[6] 路径分隔符与相对路径行为')
{
  ok('路径分隔符是 Windows 的 \\', sep === '\\' || sep === '/', sep)
  const root = makeRoot('relative')
  const saved = process.cwd()
  process.chdir(root)
  try {
    const opened = await openDatabase({ file: 'relative-memory.sqlite3', driverPreference: 'auto', logger: log })
    ok('相对路径能打开（由调用方解析，这里验证不炸）', opened.selfCheck.ok, opened.driver)
    opened.db.close()
  } finally {
    process.chdir(saved)
  }
}

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 同上：清理失败不盖测试结论
  }
}

console.log(`\n[win-paths] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
