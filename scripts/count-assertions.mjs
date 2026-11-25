// 统计 `npm run test *> 日志` 里的断言数。
// 用法：node scripts/count-assertions.mjs <日志文件>
// 说明：PowerShell 的 `*>` 重定向写出的是 UTF-16LE（BOM ff fe），Node 按 utf8 读会全是乱码，这里先判 BOM。
// 汇总行有两种：带失败列的（`N 通过 M 失败` / `N passed M failed`）和只有通过数的（`name: N 通过`）。
// 两种都算进总数，但分开报，方便和只累加「带失败列」的旧口径对齐。
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/count-assertions.mjs <log-file>')
  process.exit(2)
}

const buf = readFileSync(file)
const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8').replace(/^\uFEFF/, '')
const lines = text.split(/\r?\n/)

let pairedPassed = 0
let pairedFailed = 0
let pairedSuites = 0
let barePassed = 0
let bareSuites = 0
const fails = []

for (const line of lines) {
  const text = line.trim()
  const cn = /(\d+)\s*通过\s*[，,／/]?\s*(\d+)\s*失败/.exec(text)
  const en = /(\d+)\s*passed\s*[，,]?\s*(\d+)\s*failed/i.exec(text)
  if (cn || en) {
    const hit = cn ?? en
    pairedPassed += Number(hit[1])
    pairedFailed += Number(hit[2])
    pairedSuites += 1
    continue
  }
  const bare = /^(.*?)(\d+)\s*通过\s*$/.exec(text)
  if (bare && !/失败/.test(text)) {
    barePassed += Number(bare[2])
    bareSuites += 1
  }
  if (/^FAIL\b/.test(text) || /\bFAILED\b/.test(text)) fails.push(text)
}

console.log(JSON.stringify({
  lines: lines.length,
  suites: pairedSuites + bareSuites,
  passed: pairedPassed + barePassed,
  failed: pairedFailed,
  paired: { suites: pairedSuites, passed: pairedPassed, failed: pairedFailed },
  bare: { suites: bareSuites, passed: barePassed },
}, null, 2))
if (fails.length > 0) {
  console.error('FAIL lines:')
  for (const line of fails.slice(0, 20)) console.error('  ' + line.slice(0, 200))
  process.exit(1)
}
