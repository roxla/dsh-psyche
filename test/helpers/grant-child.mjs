// 跨进程 Grant 消费的测试子进程（E5.5-E1）。
//
// 父进程建好库、造一条受限事实、签发一张 grant，然后拉起两个这样的子进程，
// 用 barrier 文件同步起跑，各自在一个真事务里尝试用同一张 grant 把内容提到 public。
// 期望：恰好一个成功；另一个撞 revision 乐观检查失败，且没有消费 grant。
import { existsSync, writeFileSync } from 'node:fs'
import { openDatabase } from '../../dist/lib/adapter.js'
import { Core } from '../../dist/lib/store.js'

const [dbFile, artifactId, grantId, eventId, barrier, resultPath] = process.argv.slice(2)

function write(payload) {
  writeFileSync(resultPath, JSON.stringify(payload))
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

write({ ready: true })
while (!existsSync(barrier)) {
  await wait(20)
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
const db = opened.db
const core = new Core({ db, config: {}, logger: log, dataDir: process.env.PSYCHE_TEST_DIR || '.' })

try {
  const result = await core.revise({
    artifactId,
    statement: '用户的手机号是 13800138000，只允许本地加密保存。',
    refs: [eventId],
    disclosure: 'public',
    disclosureGrant: grantId,
    expectedRevision: 1,
  })
  write({ ok: true, revision: result.revision, disclosure: result.disclosure, grantRequired: result.grantRequired })
} catch (error) {
  write({ ok: false, code: error && error.code ? error.code : null, message: String(error && error.message ? error.message : error) })
} finally {
  db.close()
}
