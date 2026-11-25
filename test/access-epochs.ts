// 迁移 36：授权代次的策略侧持久化。
//
// 这一层要防的不是「撤销后回复照发」，而是「重启后桥接不认得上次数到第几代」——
// 那时它在内存里从 0 起，而任务行上的 access_epoch 停在 2 或 3，所有在途回复都会被
// 判 access-superseded。比误发安全，但用户看到的是「重启之后他就不理我了」。
//
// 六个断言分别守住：读回、只增不减、重复保存不写库、撤销也保留记录、未知 peer 返回
// null（不是 0）、跨重启真的能接着数。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accessEpochOf,
  beginAccessEpochChange,
  commitAccessEpochChange,
  loadAccessEpochs,
  loadPendingEpochs,
  saveAccessEpochs,
} from '../packages/core/dist/access-epochs.js'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'

let passed = 0
let failed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(error instanceof Error ? error.stack : String(error))
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'psyche-epoch-'))
const file = join(root, 'memory.sqlite3')
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const opened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
let db = opened.db
migrate(db, quiet)
const now = '2026-11-22T19:00:00.000Z'

await test('E1 空表就是空 Map（第一次启动）', () => {
  eq('load', [...loadAccessEpochs(db, 'main')], [])
})

await test('E2 写入后能读回，未知 peer 返回 null 而不是 0', () => {
  const written = saveAccessEpochs({ db, personaId: 'main', epochs: new Map([['private:111', 2]]), now })
  eq('写了几行', written, 1)
  eq('读回', loadAccessEpochs(db, 'main').get('private:111'), 2)
  eq('未知 peer', accessEpochOf(db, 'main', 'private:999'), null)
})

await test('E3 代次只增不减：库里更大时保留库里的值', () => {
  const written = saveAccessEpochs({ db, personaId: 'main', epochs: new Map([['private:111', 1]]), now })
  eq('没有写入', written, 0)
  eq('值没被拉回去', accessEpochOf(db, 'main', 'private:111'), 2)
})

await test('E4 重复保存同一份不写库', () => {
  const written = saveAccessEpochs({ db, personaId: 'main', epochs: new Map([['private:111', 2]]), now })
  eq('写了几行', written, 0)
})

await test('E5 撤销也保留记录：涨上去就不再回来', () => {
  saveAccessEpochs({ db, personaId: 'main', epochs: new Map([['private:111', 3], ['private:222', 1]]), now })
  eq('111', accessEpochOf(db, 'main', 'private:111'), 3)
  eq('222', accessEpochOf(db, 'main', 'private:222'), 1)
})

await test('E6 跨重启：关库重开，代次接着数而不是从 0 起', async () => {
  db.close()
  const reopened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
  db = reopened.db
  const reloaded = loadAccessEpochs(db, 'main')
  eq('111 还在', reloaded.get('private:111'), 3)
  eq('222 还在', reloaded.get('private:222'), 1)
  // 重新授权 → 再加一，不能退回到 0
  saveAccessEpochs({ db, personaId: 'main', epochs: new Map([...reloaded, ['private:222', 2]]), now })
  eq('222 涨到 2', accessEpochOf(db, 'main', 'private:222'), 2)
})

// ── 两阶段提交（迁移 37） ────────────────────────────────────────────────
await test('P1 先记 pending，此时代次还没动', () => {
  const targets = new Map([['private:333', 1]])
  eq('记了几行', beginAccessEpochChange({ db, personaId: 'main', targets, now }), 1)
  eq('pending 里有 333', loadPendingEpochs(db, 'main').get('private:333'), 1)
  // 关键：这时 access_epochs 里还没有 333——名字就是「打算」，不是「已经」。
  eq('代次仍是未知', accessEpochOf(db, 'main', 'private:333'), null)
})

await test('P2 提交后代次落库、pending 清空', () => {
  const epochs = loadAccessEpochs(db, 'main')
  epochs.set('private:333', 1)
  const written = commitAccessEpochChange({ db, personaId: 'main', epochs, now })
  eq('写了几行', written, 1)
  eq('333 落库', accessEpochOf(db, 'main', 'private:333'), 1)
  eq('pending 已清', loadPendingEpochs(db, 'main').size, 0)
})

await test('P3 崩在中途：pending 留着，重启后这个对象必须暂停', async () => {
  // 模拟「覆盖文件写了、代次没提交」：只做第一阶段。
  beginAccessEpochChange({ db, personaId: 'main', targets: new Map([['private:444', 2]]), now })
  db.close()
  const reopened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
  db = reopened.db
  const pending = loadPendingEpochs(db, 'main')
  eq('重启后仍能看见未完成变更', pending.get('private:444'), 2)
  // 桥接拿到这份 pending 会暂停 private:444；不能用 target_epoch 当现值放行。
  eq('代次没有被偷偷写成 2', accessEpochOf(db, 'main', 'private:444'), null)
})

console.log(`\n[access-epochs] ${passed} 通过 ${failed} 失败`)
try {
  db.close()
} catch {}
rmSync(root, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
