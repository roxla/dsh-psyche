// 心灵 id 生成：一律规则生成，模型不能自填（设计 §11.4 第 3 步）。
// 形如 evt_<36 进制时间戳><10 位随机>：时间前缀让同一毫秒内的 id 天然可排序，随机后缀防撞。
// 纯函数 + 一个加密随机源，零 IO、不读库；被 store.ts / growth.ts 在落库前调用。
// 不变量：前缀决定业务域（外部按前缀判类型），所以 `PREFIX` 的值是契约，只增不改。
import { randomBytes } from 'node:crypto'

/**
 * id 的业务域；值就是 id 前缀（短、稳定、可读）。
 *
 * `pending`（`pw`）是待确认提案、`window`（`win`）是唤醒窗口、`history`（`hst`）是会话历史。
 */
export const PREFIX = Object.freeze({
  event: 'evt',
  artifact: 'art',
  source: 'src',
  operation: 'op',
  signal: 'sig',
  proposal: 'prop',
  pending: 'pw',
  window: 'win',
  contact: 'ct',
  room: 'rm',
  history: 'hst',
  tension: 'ten',
  /** 决策回执（v16 起）：一次决策一个壳，决策依据在 decision_items。 */
  decision: 'dec',
  /** 日记（v18 起）：派生叙事，正文版本在 diary_versions，不参与事实计数。 */
  diary: 'dly',
  /** 写入准入观测（v3 起）：外部一般不按前缀判类型，但保持与前缀规则一致。 */
  observation: 'adm',
  /** 披露授权凭据（v7 起）：宿主侧可信流程产生，一次性使用。 */
  grant: 'grn',
  /** 成长反思（v25 起）：一次触发一行，id 只作回溯指针。 */
  reflection: 'grf',
  /** 成长候选（v25 起）：rule-only v1 只生成候选，不确认。 */
  candidate: 'gca',
  /** 成长确认决策（v26 起）：append-only 账本，confirm/reject/withdraw。 */
  confirmation: 'gcf',
  /** 外界来源登记（v28 起）：只登记来源，不复制正文。 */
  external: 'ext',
} as const)

/** 业务域名的联合类型（`'event' | 'artifact' | …`）。 */
export type IdDomain = keyof typeof PREFIX
/** 前缀字面量的联合类型（`'evt' | 'art' | …`），`newId` 只收这一种。 */
export type IdPrefix = (typeof PREFIX)[IdDomain]

/**
 * 生成一个 id：`<prefix>_<时间戳 36 进制><5 字节随机 hex>`。
 *
 * 参数 `prefix`：必须是 `PREFIX` 里的值（编译期保证，不会拼出 `art2_` 这种）。
 * 返回：形如 `evt_m3k9f2a1b2c3d4e5f6` 的字符串。
 * 边界：36 进制时间戳保证「越晚生成的越长/越大」，但**同一毫秒内**只能靠随机后缀区分；
 * 随机只取 5 字节（40 位），碰撞概率足够低，不是 UUID 那种强度。
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`
}

/**
 * 唤醒窗口的 key：`win_<开始时间 36 进制><3 字节随机>_<会话引用>`。
 *
 * 参数：`sessionRef` 会话引用（空则用 `nosession`，截断到 40 字符）；`startedAt` 窗口开始时间
 * （任意可被 `Date` 解析的字符串）。返回：稳定可读的 key。
 * 边界：`startedAt` 解析失败会得到 `NaN` 的时间戳（`toString(36)` 返回 `"NaN"`），
 * 不会抛错——调用方应保证传入合法时间；随机后缀让同一秒的两个窗口也不会撞。
 * 注意：`session` 段可能含分隔符，所以 key 只能整体当不透明字符串用，别按 `_` 拆。
 */
export function newWindowKey(sessionRef: string, startedAt: string): string {
  const stamp = new Date(startedAt).getTime().toString(36)
  const session = String(sessionRef || 'nosession').slice(0, 40)
  return `${PREFIX.window}_${stamp}${randomBytes(3).toString('hex')}_${session}`
}

/**
 * 稳定序列化：object 键排序，供入参哈希使用。
 * 同一份入参不管键顺序怎么排，都得到同一段字符串。
 *
 * 参数 `value`：任意 JSON 值（对象/数组/原始值）。返回：确定性的字符串。
 * 边界：根部是 undefined / 函数时 `JSON.stringify` 返回 undefined，这里兜成字面量 `'null'`；
 * 数组保持原序（顺序本身是语义的一部分），只对对象键排序。
 * 注意：不做循环引用检测——传进来的应是被校验过的入参，不是任意对象图。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
