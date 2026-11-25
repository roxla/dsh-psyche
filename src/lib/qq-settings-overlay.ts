/**
 * Q1：QQ 访问控制与默认模型的「插件覆盖层」。
 *
 * 为什么不直接改宿主插件配置：`qq.allowFrom` / `qq.provider` 属于宿主的
 * `cordis.patch.yml`，宿主对它有 zod 校验与热更新语义，插件回写自己的配置段
 * 容易连带影响同一文件里的其它键。这里改成「插件自己的覆盖文件 + 宿主配置兜底」：
 * - 某一组没有覆盖记录 → 该组整组继承宿主配置；
 * - 某一组有覆盖记录 → 该组整组使用覆盖值，界面标明「来自插件覆盖」；
 * - 恢复宿主配置 = 删掉该组的覆盖记录，不是把宿主值抄一份进来。
 *
 * 边界：
 * - 只写本机私有目录里的一个 JSON 文件；不碰宿主配置、不碰 SnowLuma、不碰记忆库。
 * - 读到损坏文件时**不写回**（保留原文件给用户排查），写操作一律拒绝。
 * - 两组互相独立：保存其中一组时原样保留另一组的内容。
 * - 所有写入串行执行并在同一把锁里完成「读 → 校验 revision → 合并 → 原子替换」，
 *   避免两个控制中心标签页同时保存时互相覆盖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 与 `qq-bridge.ts` 的 `QQ_ADMISSION_ID` 保持同一条：正整数、最长 20 位。 */
const QQ_ID = /^[1-9][0-9]{0,19}$/

export interface QqAccessValue {
  owner: string
  extra: string[]
  /** 额外允许的群号。和私聊分开存：群聊的对象是「哪个群」，私聊是「哪个人」。 */
  groups: string[]
}

export interface QqModelValue {
  provider: string
  model: string
  /** 空串或缺失表示「用模型默认」；无档位模型保存时必须为空。 */
  reasoningEffort?: string
}

export type QqOverlaySource = 'overlay' | 'host'

/**
 * 第二批：目标级允许回复时段。
 *
 * 键是 `private:<QQ号>` / `group:<群号>`，同号不同类分别存——一个群号和一个 QQ 号
 * 即使数字相同，也是两个对象。规则本身不授予任何权限：它只在既有名单与身份检查
 * 通过之后，决定「现在这个时刻允许回复吗」。
 */
export interface QqReplyWindowRule {
  /** ISO 星期：1=周一 … 7=周日；保存时去重并升序。 */
  days: number[]
  /** 当地分钟数 0–1439。 */
  startMinute: number
  /** 当地分钟数 0–1439；小于 startMinute 表示跨夜到次日。 */
  endMinute: number
}

export type QqReplyRule =
  | { mode: 'paused' }
  | { mode: 'windows'; timeZone: string; windows: QqReplyWindowRule[] }

export type QqReplySchedules = Record<string, QqReplyRule>

export interface QqEffective<T> {
  value: T
  source: QqOverlaySource
  /** 覆盖文件当前修订号；没有覆盖记录时为宿主值加 0。 */
  revision: number
}

export interface QqOverlaySnapshot {
  revision: number
  hasAccessOverride: boolean
  hasModelOverride: boolean
  access: QqAccessValue
  modelSelection: QqModelValue
  accessSource: QqOverlaySource
  modelSource: QqOverlaySource
  /** 非空表示这些对象不继承「随时可回复」，而是按各自规则判定。 */
  replySchedules: QqReplySchedules
}

/** 覆盖文件读不出来 / 结构不对。写操作遇到它必须拒绝，不能「覆盖掉再重建」。 */
export class QqOverlayCorruptError extends Error {
  readonly code = 'E_OVERLAY_CORRUPT'
  readonly detail: string
  constructor(detail: string) {
    super(`QQ 覆盖文件不可用：${detail}`)
    this.name = 'QqOverlayCorruptError'
    this.detail = detail
  }
}

/** 表单里的修订号已经过期（别的标签页先保存了）。 */
export class QqOverlayConflictError extends Error {
  readonly code = 'E_REVISION_CONFLICT'
  readonly expected: number
  readonly actual: number
  constructor(expected: number, actual: number) {
    super(`配置已被其他窗口更新（期望修订 ${expected}，当前 ${actual}）`)
    this.name = 'QqOverlayConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** 表单内容不合法。 */
export class QqOverlayValidationError extends Error {
  readonly code = 'E_VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'QqOverlayValidationError'
  }
}

interface RawOverlay {
  revision: number
  access?: QqAccessValue
  modelSelection?: QqModelValue
  replySchedules?: QqReplySchedules
}

export interface QqSettingsOverlayOptions {
  /** 覆盖文件绝对路径；父目录不存在时会创建。 */
  file: string
  logger?: { warn?: (message: string) => void }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 规范化一份 owner + extra。
 *
 * 纪律与 `parseQqAllowFrom` 一致但方向相反：那边是「有一条坏就整份失效、一律拒绝」，
 * 这里是「有一条坏就拒绝整次保存」，让用户看到具体是哪一条，而不是静默放行/静默丢弃。
 * QQ 号全程保持字符串，不转数字——避免 20 位号被 JSON 数字精度截断。
 */
export function normalizeQqAccess(input: unknown): QqAccessValue {
  const source = isPlainObject(input) ? input : {}
  const owner = readString(source.owner)
  if (owner !== '' && !QQ_ID.test(owner)) {
    throw new QqOverlayValidationError(`主人 QQ 号不合法：${owner}`)
  }
  const rawExtra = Array.isArray(source.extra) ? source.extra : []
  const seen = new Set<string>()
  const extra: string[] = []
  for (const item of rawExtra) {
    const id = readString(item)
    if (id === '') continue
    if (!QQ_ID.test(id)) {
      throw new QqOverlayValidationError(`额外允许的 QQ 号不合法：${id}`)
    }
    if (id === owner) continue
    if (seen.has(id)) continue
    seen.add(id)
    extra.push(id)
  }
  // 群号与私聊号同一套校验规则（都是正整数、最长 20 位），但存两个数组：
  // 一个人可以在白名单里、却不在任何一个白名单群里，反过来也一样。
  const rawGroups = Array.isArray(source.groups) ? source.groups : []
  const seenGroups = new Set<string>()
  const groups: string[] = []
  for (const item of rawGroups) {
    const id = readString(item)
    if (id === '') continue
    if (!QQ_ID.test(id)) {
      throw new QqOverlayValidationError(`白名单群号不合法：${id}`)
    }
    if (seenGroups.has(id)) continue
    seenGroups.add(id)
    groups.push(id)
  }
  return { owner, extra, groups }
}

/** 规范化模型选择。provider / model 都必填，effort 可空（= 用模型默认）。 */
export function normalizeQqModelSelection(input: unknown): QqModelValue {
  const source = isPlainObject(input) ? input : {}
  const provider = readString(source.provider)
  const model = readString(source.model)
  if (provider === '') throw new QqOverlayValidationError('提供方不能为空')
  if (model === '') throw new QqOverlayValidationError('模型不能为空')
  const effortRaw = source.reasoningEffort
  const reasoningEffort = effortRaw === undefined || effortRaw === null ? '' : readString(effortRaw)
  return reasoningEffort === '' ? { provider, model } : { provider, model, reasoningEffort }
}

/**
 * 第二批：允许回复时段的对象键。
 *
 * 只接受 `private:<QQ号>` / `group:<群号>` 两种形状：键写错就没法在界面上找到该对象，
 * 也没法在发送路径上按对象查规则，所以这里宁可整次拒绝，不做「猜一个」的修补。
 */
export interface QqReplyTarget {
  kind: 'private' | 'group'
  id: string
}

const REPLY_KEY = /^(private|group):([1-9][0-9]{0,19})$/

export function replyTargetKey(target: QqReplyTarget): string {
  return `${target.kind}:${target.id}`
}

export function normalizeReplyTarget(input: unknown): QqReplyTarget {
  const source = isPlainObject(input) ? input : {}
  const kind = readString(source['kind'])
  const id = readString(source['id'])
  if (kind !== 'private' && kind !== 'group') {
    throw new QqOverlayValidationError(`允许回复时段的对象类型不合法：${kind || '空'}`)
  }
  if (!QQ_ID.test(id)) {
    throw new QqOverlayValidationError(`${kind === 'group' ? '群' : 'QQ'}号不合法：${id || '空'}`)
  }
  return { kind, id }
}

/** 时区必须被运行时接受；只做「构造一次 Intl」这一种校验，不维护自己的时区表。 */
function assertTimeZone(timeZone: string): void {
  if (timeZone === '') throw new QqOverlayValidationError('时区不能为空')
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone })
  } catch {
    throw new QqOverlayValidationError(`时区不合法：${timeZone}`)
  }
}

/**
 * 规范化一条允许回复时段规则。
 *
 * 拒绝：未知 mode、空时区/非法时区、空星期、非 1–7 的星期、非整数或越界分钟、
 * 起止相同（含 00:00–00:00「全天」）、`windows` 一段都没有。
 */
export function normalizeReplyRule(input: unknown): QqReplyRule {
  if (!isPlainObject(input)) throw new QqOverlayValidationError('规则必须是对象')
  const mode = readString(input['mode'])
  if (mode === 'paused') return { mode: 'paused' }
  if (mode !== 'windows') throw new QqOverlayValidationError(`未知的规则类型：${mode || '空'}`)
  const timeZone = readString(input['timeZone'])
  assertTimeZone(timeZone)
  const rawWindows = Array.isArray(input['windows']) ? input['windows'] : []
  if (rawWindows.length === 0) throw new QqOverlayValidationError('自定义时段至少需要一段')
  const windows: QqReplyWindowRule[] = []
  for (const raw of rawWindows) {
    const window = isPlainObject(raw) ? raw : {}
    const rawDays = Array.isArray(window['days']) ? window['days'] : []
    const days: number[] = []
    for (const day of rawDays) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
        throw new QqOverlayValidationError(`星期必须是 1–7 的整数：${String(day)}`)
      }
      if (days.indexOf(day) < 0) days.push(day)
    }
    if (days.length === 0) throw new QqOverlayValidationError('时段的星期不能为空')
    days.sort((a, b) => a - b)
    const startMinute = readMinute(window['startMinute'], '开始时间')
    const endMinute = readMinute(window['endMinute'], '结束时间')
    if (startMinute === endMinute) {
      throw new QqOverlayValidationError('开始与结束时间不能相同（不提供 00:00–00:00 表示全天）')
    }
    windows.push({ days, startMinute, endMinute })
  }
  return { mode: 'windows', timeZone, windows }
}

function readMinute(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1439) {
    throw new QqOverlayValidationError(`${label}必须是 0–1439 的整数分钟：${String(value)}`)
  }
  return value
}

/** 读覆盖文件里的整组规则：任何一条坏就整份算损坏（与 access 组同一纪律）。 */
export function normalizeReplySchedules(input: unknown): QqReplySchedules {
  if (!isPlainObject(input)) throw new QqOverlayValidationError('replySchedules 必须是对象')
  const result: QqReplySchedules = {}
  for (const [key, value] of Object.entries(input)) {
    if (!REPLY_KEY.test(key)) throw new QqOverlayValidationError(`对象键不合法：${key}`)
    result[key] = normalizeReplyRule(value)
  }
  return result
}

export class QqSettingsOverlay {
  readonly #file: string
  readonly #logger: { warn?: (message: string) => void } | undefined
  /** 所有写入串成一条链；读不受影响（读的是已落盘状态，天然一致）。 */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: QqSettingsOverlayOptions) {
    this.#file = options.file
    this.#logger = options.logger
  }

  get file(): string {
    return this.#file
  }

  /** 读原始覆盖文件。不存在等同于「两组都没有覆盖」。 */
  read(): RawOverlay {
    if (!existsSync(this.#file)) return { revision: 0 }
    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      throw new QqOverlayCorruptError(errorText(error))
    }
    if (text.trim() === '') return { revision: 0 }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new QqOverlayCorruptError(`JSON 解析失败：${errorText(error)}`)
    }
    if (!isPlainObject(parsed)) throw new QqOverlayCorruptError('顶层不是对象')
    const revisionRaw = parsed['revision']
    const revision = typeof revisionRaw === 'number' && Number.isSafeInteger(revisionRaw) && revisionRaw >= 0 ? revisionRaw : 0
    const result: RawOverlay = { revision }
    if (parsed['access'] !== undefined) {
      try {
        result.access = normalizeQqAccess(parsed['access'])
      } catch (error) {
        throw new QqOverlayCorruptError(`access 组不合法：${errorText(error)}`)
      }
    }
    if (parsed['modelSelection'] !== undefined) {
      try {
        result.modelSelection = normalizeQqModelSelection(parsed['modelSelection'])
      } catch (error) {
        throw new QqOverlayCorruptError(`modelSelection 组不合法：${errorText(error)}`)
      }
    }
    if (parsed['replySchedules'] !== undefined) {
      try {
        result.replySchedules = normalizeReplySchedules(parsed['replySchedules'])
      } catch (error) {
        throw new QqOverlayCorruptError(`replySchedules 组不合法：${errorText(error)}`)
      }
    }
    return result
  }

  /**
   * 计算两组当前的有效值。
   *
   * @param hostAccess 宿主配置里的 allowFrom（覆盖缺失时的兜底）
   * @param hostModel 宿主配置里的 provider / model / reasoningEffort
   */
  effective(
    hostAccess: { owner?: string; extra?: string[]; groups?: string[] } | undefined,
    hostModel: { provider?: string; model?: string; reasoningEffort?: string } | undefined,
  ): QqOverlaySnapshot {
    const raw = this.read()
    const hostAccessValue: QqAccessValue = {
      owner: readString(hostAccess?.owner),
      extra: Array.isArray(hostAccess?.extra) ? hostAccess.extra.map((id) => readString(id)).filter((id) => id !== '') : [],
      groups: Array.isArray(hostAccess?.groups) ? hostAccess.groups.map((id) => readString(id)).filter((id) => id !== '') : [],
    }
    const hostEffort = readString(hostModel?.reasoningEffort)
    const hostModelValue: QqModelValue = {
      provider: readString(hostModel?.provider),
      model: readString(hostModel?.model),
      ...(hostEffort === '' ? {} : { reasoningEffort: hostEffort }),
    }
    const hasAccessOverride = raw.access !== undefined
    const hasModelOverride = raw.modelSelection !== undefined
    return {
      revision: raw.revision,
      hasAccessOverride,
      hasModelOverride,
      access: hasAccessOverride ? raw.access! : hostAccessValue,
      modelSelection: hasModelOverride ? raw.modelSelection! : hostModelValue,
      accessSource: hasAccessOverride ? 'overlay' : 'host',
      modelSource: hasModelOverride ? 'overlay' : 'host',
      replySchedules: raw.replySchedules === undefined ? {} : raw.replySchedules,
    }
  }

  /** 保存访问控制组；`expectedRevision` 与服务端不一致时抛冲突。返回新修订号。 */
  saveAccess(input: unknown, expectedRevision: number): Promise<number> {
    const value = normalizeQqAccess(input)
    return this.#mutate(expectedRevision, (raw) => ({ ...raw, access: value }), 'access/save')
  }

  /** 保存默认模型组。返回新修订号。 */
  saveModelSelection(input: unknown, expectedRevision: number): Promise<number> {
    const value = normalizeQqModelSelection(input)
    return this.#mutate(expectedRevision, (raw) => ({ ...raw, modelSelection: value }), 'model/save')
  }

  /** 恢复宿主配置：只删本组覆盖，另一组原样保留。返回新修订号。 */
  clearAccess(expectedRevision: number): Promise<number> {
    return this.#mutate(expectedRevision, (raw) => {
      const next: RawOverlay = { revision: raw.revision }
      if (raw.modelSelection !== undefined) next.modelSelection = raw.modelSelection
      if (raw.replySchedules !== undefined) next.replySchedules = raw.replySchedules
      return next
    }, 'access/clear')
  }

  clearModelSelection(expectedRevision: number): Promise<number> {
    return this.#mutate(expectedRevision, (raw) => {
      const next: RawOverlay = { revision: raw.revision }
      if (raw.access !== undefined) next.access = raw.access
      if (raw.replySchedules !== undefined) next.replySchedules = raw.replySchedules
      return next
    }, 'model/clear')
  }

  /**
   * 保存某个对象的允许回复时段；`rule === null` 表示删除该对象的规则（恢复继承）。
   *
   * 只动一个键：其它对象的规则、访问名单与模型组原样保留；该对象最后一条被删掉时
   * 整组 `replySchedules` 也一并移除，避免文件里留下空对象。
   */
  saveReplyRule(target: QqReplyTarget, rule: QqReplyRule | null, expectedRevision: number): Promise<number> {
    const key = replyTargetKey(normalizeReplyTarget(target))
    const value = rule === null ? null : normalizeReplyRule(rule)
    return this.#mutate(
      expectedRevision,
      (raw) => {
        const schedules: QqReplySchedules = { ...(raw.replySchedules ?? {}) }
        if (value === null) delete schedules[key]
        else schedules[key] = value
        const next: RawOverlay = {
          revision: raw.revision,
          ...(raw.access === undefined ? {} : { access: raw.access }),
          ...(raw.modelSelection === undefined ? {} : { modelSelection: raw.modelSelection }),
          ...(Object.keys(schedules).length === 0 ? {} : { replySchedules: schedules }),
        }
        return next
      },
      value === null ? 'reply-schedule/clear' : 'reply-schedule/save',
    )
  }

  /**
   * 串行执行「读 → 校验修订 → 合并 → 原子替换」。
   *
   * 整段放进队列的意义：两个标签页同时保存时，第二个必然读到第一个写完的 revision，
   * 从而拿到冲突而不是把对方覆盖掉。
   */
  #mutate(
    expectedRevision: number,
    build: (raw: RawOverlay) => RawOverlay,
    action: string,
  ): Promise<number> {
    const run = async (): Promise<number> => {
      const raw = this.read()
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== raw.revision) {
        throw new QqOverlayConflictError(expectedRevision, raw.revision)
      }
      const merged = build(raw)
      const next: RawOverlay = { revision: raw.revision + 1 }
      if (merged.access !== undefined) next.access = merged.access
      if (merged.modelSelection !== undefined) next.modelSelection = merged.modelSelection
      if (merged.replySchedules !== undefined) next.replySchedules = merged.replySchedules
      this.#write(next)
      this.#logger?.warn?.(`[psyche][qq-overlay] ${action} 已写入，revision=${next.revision}`)
      return next.revision
    }
    const chained = this.#queue.then(run, run)
    // 队列本身不能被一次失败卡死：接住错误只为了让后续写入继续排队。
    this.#queue = chained.then(
      () => undefined,
      () => undefined,
    )
    return chained
  }

  /**
   * 原子替换：先写同目录临时文件再 rename。
   *
   * Windows 上 rename 覆盖已存在文件是允许的（Node 用 MoveFileEx 语义），
   * 所以不需要先删目标——先删会在断电窗口里丢配置。
   */
  #write(next: RawOverlay): void {
    const dir = dirname(this.#file)
    mkdirSync(dir, { recursive: true })
    const temp = `${this.#file}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8' })
    renameSync(temp, this.#file)
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
