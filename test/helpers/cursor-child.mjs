// P2-CAP-1c3-B 跨进程并发认领的子进程。
//
// 用法：node cursor-child.mjs <dbFile> <owner> <barrierPath> <resultPath>
//
// 流程：写 ready → 等 barrier → 用独立连接认领同一个会话游标 → 写结果 JSON。
// 两个进程同时认领，父进程验证「恰好一个成功、库里版本只加一次」。

import { existsSync, writeFileSync } from 'node:fs'
import { openDatabase } from '../../dist/lib/adapter.js'
import { CaptureCursorStore } from '../../dist/lib/capture-cursor.js'

const [dbFile, owner, barrierPath, resultPath] = process.argv.slice(2)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function writeResult(payload) {
  try {
    writeFileSync(resultPath, JSON.stringify(payload), 'utf8')
  } catch {
    // 父进程读不到自然会失败
  }
}

async function main() {
  try {
    writeFileSync(`${resultPath}.ready`, '1', 'utf8')
  } catch {
    // 忽略
  }

  const deadline = Date.now() + 15000
  while (!existsSync(barrierPath)) {
    if (Date.now() > deadline) {
      writeResult({ ok: false, message: 'barrier timeout' })
      process.exit(2)
    }
    await sleep(20)
  }

  let opened = null
  try {
    opened = await openDatabase({ file: dbFile })
    const store = new CaptureCursorStore({
      db: opened.db,
      now: () => '2026-11-05T10:00:00.000Z',
      leaseMs: 60_000,
    })
    const claim = store.claim(
      { platform: 'dsh', sessionRef: 'session-concurrent' },
      { owner, scanTargetSeq: 100 },
    )
    writeResult({ ok: claim !== null, owner, cursorVersion: claim?.cursorVersion ?? null })
  } catch (error) {
    writeResult({
      ok: false,
      code: error?.code ?? null,
      message: error instanceof Error ? error.message : String(error),
    })
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
