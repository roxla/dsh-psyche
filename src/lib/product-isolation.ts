import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PRODUCT_ID = 'dsh-psyche'
export const PRODUCT_FORMAT_VERSION = 1
export const PRODUCT_MARKER = 'product.json'
const PRODUCT_TEMP_MARKER = `.${PRODUCT_MARKER}.tmp`

export interface ProductMarker {
  product: string
  formatVersion: number
}

/**
 * 数据目录归属门禁：必须在打开 SQLite、写 config-audit 或应用恢复之前调用。
 *
 * 规则：
 * - 空目录 → 写入 product.json 后初始化；
 * - product.json 存在且 product/formatVersion 匹配 → 继续；
 * - 其余（旧 Lingban 目录、已有库但无标识、标识损坏/版本不符）→ 抛错，拒绝接管。
 *
 * 这个标识只用于防止误操作，不是 Owner 身份凭据。
 */
export function ensureProductDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const markerFile = join(dataDir, PRODUCT_MARKER)

  if (existsSync(markerFile)) {
    let parsed: Partial<ProductMarker> | null = null
    try {
      parsed = JSON.parse(readFileSync(markerFile, 'utf8')) as Partial<ProductMarker>
    } catch {
      throw new Error(`数据目录标记损坏，拒绝启动：${markerFile}`)
    }
    if (parsed?.product !== PRODUCT_ID || parsed?.formatVersion !== PRODUCT_FORMAT_VERSION) {
      throw new Error(`数据目录属于其他产品或格式版本，拒绝启动：${markerFile}`)
    }
    return
  }

  const entries = readdirSync(dataDir).filter(
    (name) => name !== PRODUCT_MARKER && name !== PRODUCT_TEMP_MARKER,
  )
  if (entries.length > 0) {
    throw new Error(
      `数据目录非空且缺少 ${PRODUCT_MARKER}，拒绝接管（可能是旧 Lingban 数据目录）：${dataDir}`,
    )
  }

  const marker: ProductMarker = { product: PRODUCT_ID, formatVersion: PRODUCT_FORMAT_VERSION }
  const tempFile = join(dataDir, PRODUCT_TEMP_MARKER)
  try {
    writeFileSync(tempFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    renameSync(tempFile, markerFile)
  } catch (error) {
    try {
      unlinkSync(tempFile)
    } catch {
      // 清理失败不掩盖原始写入错误；下次启动仍可按空目录重试。
    }
    throw error
  }
}
