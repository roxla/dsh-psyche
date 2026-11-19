// PSY-M05：数据目录归属门禁。只测纯函数，不启动 Host、不打开真实数据库。
// 直接对着构建产物跑：node test/product-isolation.ts（需先 pnpm run build）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRODUCT_FORMAT_VERSION,
  PRODUCT_ID,
  PRODUCT_MARKER,
  ensureProductDataDir,
} from '../dist/lib/product-isolation.js'

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

function throws(label, fn, includes) {
  try {
    fn()
    ok(label, false, 'expected throw')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ok(label, includes === undefined || message.includes(includes), { message })
  }
}

const roots = []
function makeRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `psyche-product-${tag}-`))
  roots.push(root)
  return root
}

try {
  const empty = makeRoot('empty')
  ensureProductDataDir(empty)
  const markerFile = join(empty, PRODUCT_MARKER)
  ok('空目录会写入 product.json', existsSync(markerFile))
  const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
  ok('product.json 带产品标识与格式版本', marker.product === PRODUCT_ID && marker.formatVersion === PRODUCT_FORMAT_VERSION, marker)

  const same = makeRoot('same')
  writeFileSync(join(same, PRODUCT_MARKER), JSON.stringify({ product: PRODUCT_ID, formatVersion: PRODUCT_FORMAT_VERSION }))
  ensureProductDataDir(same)
  ok('标识一致时允许继续', true)

  const stale = makeRoot('stale-temp')
  writeFileSync(join(stale, `.${PRODUCT_MARKER}.tmp`), '{interrupted')
  ensureProductDataDir(stale)
  ok('残留临时标记不阻塞空目录初始化', existsSync(join(stale, PRODUCT_MARKER)))
  ok('初始化成功后清理临时标记', !existsSync(join(stale, `.${PRODUCT_MARKER}.tmp`)))

  const oldDb = makeRoot('old-db')
  writeFileSync(join(oldDb, 'memory.sqlite3'), '')
  throws('旧库但无 product.json 拒绝接管', () => ensureProductDataDir(oldDb), '缺少 product.json')

  const foreign = makeRoot('foreign')
  writeFileSync(join(foreign, PRODUCT_MARKER), JSON.stringify({ product: 'other-product', formatVersion: 1 }))
  throws('其他产品标识拒绝启动', () => ensureProductDataDir(foreign), '其他产品')

  const corrupt = makeRoot('corrupt')
  writeFileSync(join(corrupt, PRODUCT_MARKER), '{not json')
  throws('标识损坏拒绝启动', () => ensureProductDataDir(corrupt), '标记损坏')
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
