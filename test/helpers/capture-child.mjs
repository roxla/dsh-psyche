// P2-CAP-1c2 跨进程并发测试的子进程。
//
// 用法：node capture-child.mjs <dataDir> <captureKey> <text> <barrierPath> <resultPath>
//
// 流程：先写自己的 ready 文件（由父进程轮询），等 barrier 出现后同时开库、capture，
// 把结果写成 JSON（sourceId / replayed / error）。两个进程抢同一个 captureKey，
// 用来验证「跨进程」而不是「同进程 Promise.all」的并发语义。

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../dist/lib/adapter.js'
import { Core } from '../../dist/lib/store.js'

const [dataDir, captureKey, text, barrierPath, resultPath] = process.argv.slice(2)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function writeResult(payload) {
  try {
    writeFileSync(resultPath, JSON.stringify(payload), 'utf8')
  } catch {
    // 父进程读不到自然会失败
  }
}

async function main() {
  // 告诉父进程「我起来了」：父进程等两个 ready 文件都出现才放 barrier
  try {
    writeFileSync(`${resultPath}.ready`, '1', 'utf8')
  } catch {
    // 忽略
  }

  // 等 barrier：确保两个进程都到了同一起跑线
  const deadline = Date.now() + 15000
  while (!existsSync(barrierPath)) {
    if (Date.now() > deadline) {
      writeResult({ error: 'barrier timeout' })
      process.exit(2)
    }
    await sleep(20)
  }

  let opened = null
  try {
    opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
    const core = new Core({ db: opened.db, dataDir })
    const result = await core.capture({
      platform: 'test-concurrent',
      channel: 'desktop',
      sessionRef: 's1',
      captureKey,
      messageId: 'm1',
      origin: 'user',
      kind: 'message',
      text,
      at: new Date().toISOString(),
    })
    writeResult({ ok: true, sourceId: result.sourceId, replayed: result.replayed })
  } catch (error) {
    writeResult({ ok: false, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) })
  } finally {
    try {
      opened?.db?.close()
    } catch {
      // 忽略
    }
  }
  process.exit(0)
}

void main()
