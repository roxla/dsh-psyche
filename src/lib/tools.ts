// 心灵的工具定义（设计 §9.1）：读写混合，现共十二个。
//
// 职责：把 Core 的方法包装成宿主认识的 ToolDefinition——parameter/description 写给模型看，
//   render 把结构化结果翻成人话文本，execute 只做转发。这里不做业务判断。
// 约束：写工具全部落 operations 表（§9.2 第 6 条），幂等靠 opId；
//   校验失败不抛到宿主，而是返回 { ok: false, code, error }，
//   让模型看见「为什么没写进去」并自行纠正——throw 会让整轮工具调用失败，模型也学不到东西。
// 约束：分区闸（growth/relationship/safety）在 Core.propose 里，本层不要提前拦，
//   否则模型拿到的错误文案会丢掉「为什么要人批准」这层信息。
// 调用方：src/index.ts 的 apply() 调 buildTools()，把返回值交给宿主工具表注册。
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/cordis'
import { jsonSafe, toErrorPayload } from './errors.js'
import { formatDateTime } from './time.js'
import { INTERACTION_TYPES, KIND_STATES } from './store.js'
import { looksSensitive } from './sensitive.js'
import type {
  ArtifactKind,
  ClashInput,
  Core,
  ForgetInput,
  ProposeInput,
  RecallQuery,
  RecallScope,
  RememberInput,
  ReviewInput,
  ReviseInput,
  StancesQuery,
} from './store.js'

// 以下是各参数的枚举值：全部从 store 的权威常量派生或手抄同一份，
// 改 store 的枚举时这几行必须一起改，否则模型会拿到 schema 允许但 Core 拒收的值。
const KIND_LIST = Object.keys(KIND_STATES) as ArtifactKind[]
const CONFIDENCE = ['low', 'medium', 'high'] as const
const VERDICT_LIST = ['confirmed', 'refined', 'challenged', 'revised', 'rejected'] as const
// 注意顺序：Core 里 growth 先被判掉（给出专门文案），所以这里必须把 growth 也列出来，
// 让模型至少能读懂「这个分区存在但不能自己提」。
const PARTITION_LIST = ['life', 'relationship', 'safety'] as const

// 幂等键的 schema 抽成常量：五个写工具完全同构，抄四遍容易漂。
const OP_ID = {
  type: 'string',
  description: '可选：本轮幂等键。同一次重试请沿用同一个 opId，换内容必须换 opId。',
} as const

// 工具结果类型直接从 Core 的方法签名取，工具层不再手写一份。
// 好处：Core 返回结构一变，render 里用到的字段会立刻在 tsc 里报错，而不是运行时 undefined。
// 敏感分类已搬进 Core（packages/core/src/sensitive.ts）：工具层的「默认 public」与
// Core 的「敏感需授权」必须用同一份判定，否则两处会漂。这里只做转发。
export { looksSensitive } from './sensitive.js'


/**
 * 工具层的披露默认值。
 *
 * Core 的默认是 `restricted`（安全默认：没有标记 ≠ 已确认可披露）。工具层对普通对话
 * 放宽成 `public`（被明确要求「记住」的事本来就该可检索），但**先看内容**：
 * 身份证、银行卡、密码、token、医疗、收入、住址、手机号这些命中敏感模式时保留
 * `restricted`——「用户说了记住」不等于「用户同意它出现在任何检索结果里」。
 * 显式传 `restricted` / `secret` / `public` 时以调用方为准。
 */
export function disclosureOf(args: unknown, statement?: unknown): 'public' | 'restricted' | 'secret' {
  const value = (args as { disclosure?: unknown }).disclosure
  if (value === 'restricted' || value === 'secret') return value
  if (value === 'public') return 'public'
  return looksSensitive(statement) ? 'restricted' : 'public'
}

type RememberResult = Awaited<ReturnType<Core['remember']>>
type ClashResult = Awaited<ReturnType<Core['clash']>>
type ReviseResult = Awaited<ReturnType<Core['revise']>>
type ReviewResult = Awaited<ReturnType<Core['review']>>
type ForgetResult = Awaited<ReturnType<Core['forget']>>
type ProposeResult = Awaited<ReturnType<Core['propose']>>
type StancesResult = Awaited<ReturnType<Core['stances']>>
type StateResult = Awaited<ReturnType<Core['getState']>>
type RelationshipResult = Awaited<ReturnType<Core['getRelationship']>>
type RecallResult = Awaited<ReturnType<Core['recall']>>
type FetchResult = Awaited<ReturnType<Core['fetch']>>
type ContextResult = Awaited<ReturnType<Core['context']>>

/**
 * 工具层只依赖这十二个方法（写 6 + 读 6），不关心 Core 是直接给的还是等 boot 之后才有的。
 * index.ts 传进来的桥接对象会先 await ready 再转发，签名保持一致。
 * 注意：这里刻意用 Core['x'] 而不是自定义接口，改 Core 签名时这里跟着变，不会出现「工具层以为还能调」。
 */
export interface ToolsCore {
  remember: Core['remember']
  clash: Core['clash']
  revise: Core['revise']
  review: Core['review']
  forget: Core['forget']
  propose: Core['propose']
  stances: Core['stances']
  getState: Core['getState']
  getRelationship: Core['getRelationship']
  recall: Core['recall']
  fetch: Core['fetch']
  context: Core['context']
}

/**
 * 把任意值渲染成文本：null/undefined/空串统一成一个占位符。
 * 为什么要专门做：模型看到字面量 "undefined" 或空行会误以为字段缺失，占位符能表达「确实没有」。
 */
function text(value: unknown, empty = '（空）'): string {
  return value === null || value === undefined || value === '' ? empty : String(value)
}

/** 工具入参在宿主侧是 unknown，这里只做形状断言；真正的校验在 Core 里。 */
function asArgs<T>(args: unknown): T {
  return (args && typeof args === 'object' ? args : {}) as T
}

/**
 * 统一出口：清成无损 JSON（宿主会校验），失败则摊平成错误载荷。
 * 参数 fn：真正的 Core 调用，入参已按形状断言过。
 * 返回：成功时是 Core 结果的 JSON 安全副本；失败时是 ErrorPayload（ok:false）。
 * 副作用：无（Core 的副作用在 fn 里）。
 * 可能抛：不抛——这是本层唯一一处把异常吃掉的地方，理由见下方 try/catch 注释。
 * 注意：错误分支的返回值与成功分支共用 output.schema（type: json），
 * 所以类型上按成功结果标注，运行时分流交给下面的 failed()。
 */
function wrap<Result>(fn: (args: unknown) => Promise<Result>): (args: unknown) => Promise<Result> {
  return async (args: unknown): Promise<Result> => {
    try {
      // jsonSafe 会剥掉 undefined/函数/循环引用：宿主对 tool 返回值做结构校验，脏值会被整轮拒掉。
      return jsonSafe(await fn(asArgs(args))) as Result
    } catch (error) {
      // 这里不 rethrow：PsycheError 的 code/detail 是给模型看的纠错线索，
      // 抛出去反而只剩一句宿主侧的通用错误。render 靠 ok:false 识别错误分支。
      return { ...toErrorPayload(error) } as unknown as Result
    }
  }
}

/** 错误载荷的最小形状：只取 render 需要的字段，避免把 ErrorPayload 的其余字段也带进类型依赖。 */
interface FailureShape {
  ok?: boolean
  code?: string
  error?: unknown
  detail?: unknown
}

/**
 * 判断 wrap 是否折叠了一个失败，是则拼成给模型看的文本块；成功结果返回 null。
 * 参数 value：execute 的返回值（结构上可能是错误载荷）。
 * 返回：null 表示「不是错误，继续走正常渲染」；否则是一个 text 块。
 * 为什么 error 要兼容三种形状：toErrorPayload 可能给 Error、字符串或 detail 对象。
 */
function failed(value: unknown): ContentBlock[] | null {
  const record = value as FailureShape | null
  // 只有显式 ok:false 才算失败：成功结果里没有 ok 字段，不能把「没写 ok」误判成失败。
  if (!record || record.ok !== false) return null
  const code = record.code ?? 'E_INTERNAL'
  const error = record.error
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error ?? null)
  // detail 只在存在时拼：undefined 会被 JSON.stringify 成 "undefined" 之外的怪串（null），干脆省掉。
  const detail = record.detail === undefined ? '' : `\n${JSON.stringify(record.detail)}`
  return [{ type: 'text', text: `心灵没有完成（${code}）：${message}${detail}` }]
}

// 宿主里 defineTool 是运行时注入的；在宿主外（单测、类型检查）解析不到这个包，
// 所以这里动态解析一次，拿不到就用恒等实现——工具定义本身是纯数据，恒等不影响断言。
const identityDefineTool = <T>(definition: ToolDefinition<T>): ToolDefinition<T> => definition

// 顶层 await 在这里是允许的（ESM）：模块加载时就把宿主实现定下来，之后 defineTool 同步调用。
let hostDefineTool: <T>(definition: ToolDefinition<T>) => ToolDefinition<T> = identityDefineTool
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  // 用 typeof 判断而不是直接赋值：某些宿主版本导出的 defineTool 是 undefined 占位。
  if (typeof mod.defineTool === 'function') {
    hostDefineTool = mod.defineTool as typeof hostDefineTool
  }
} catch {
  // 宿主外运行：保持恒等实现
}

/** 转发到宿主的 defineTool；没有宿主实现时（单测）就是恒等，保证本模块可独立加载。 */
function defineTool<T>(definition: ToolDefinition<T>): ToolDefinition<T> {
  return hostDefineTool(definition)
}

/**
 * 构造心灵全部 12 个工具定义。
 * 参数 core：Core 的桥接对象（index.ts 传「先 await ready」的版本）。
 * 参数 options.recallScope：从宿主工具执行上下文里取**可信** Recall Scope（R3）。
 *   只允许读 RuntimeInputStore 的会话绑定；模型传参一律进不到这里。
 * 返回：按固定顺序排列的 ToolDefinition 数组——顺序即模型侧工具表顺序，改动前先想清楚。
 * 副作用：无，纯构造；所有查询都在 execute 被调用时才发生。
 * 可能抛：只有 defineTool 的 schema 校验失败会抛（开发期问题，运行期不该出现）。
 */
export function buildTools(
  core: ToolsCore,
  options: { recallScope?: (exec: unknown) => RecallScope } = {},
): unknown[] {
  // 先按名字挂到中间对象上再按固定顺序返回：这样上面定义顺序可以自由排（写完再写读），
  // 而工具表顺序仍由最后那个数组决定，两者不互相绑架。
  const tools: Record<string, unknown> = {}

  // ── 写 ────────────────────────────────────────────────────

  // 写 Event → 按门下规则决定是否升 Artifact。promotion.ok=false 是正常返回，不是错误，
  // 所以 render 里专门把它翻成「暂时不够格」的人话，避免模型看见 ok:false 就以为要重试到成功。
  tools.remember = defineTool<RememberResult>({
    name: 'psyche_remember',
    description:
      '把一件值得长期保留的事写进心灵的记忆。先落一条 Event（互动记录），再按门下规则决定要不要升成 Artifact（结论）。' +
      '用户说了明确事实 → eventType=conversation、kind=fact；用户表达偏好/立场 → kind=belief 或 stance（别当事实）；' +
      '约定与承诺 → eventType=commitment；一致意见 → eventType=agreement。' +
      '门槛不够时会返回 promotion.ok=false，这是正常的：同一件事再有独立来源时再调一次即可。' +
      '不要记临时闲聊，不要整段复制对话。',
    parameters: {
      text: { type: 'string', description: '这件事本身，一句话，脱离上下文也能读懂（≤500 字）' },
      eventType: { type: 'string', enum: INTERACTION_TYPES, description: '互动类型，默认 conversation' },
      kind: {
        type: 'string',
        enum: KIND_LIST,
        description:
          '要沉淀成哪类结论；不填就只记事件、不升结论。stance 会被拒绝（正式立场由系统合成），请记成 belief',
      },
      statement: {
        type: 'string',
        description: '结论本身（给 kind 时必填）：第三人称陈述，例「用户习惯周五晚上打游戏」',
      },
      subject: { type: 'string', description: '这条结论关于谁/什么：contactId、user、topic 名，逗号分隔' },
      sourceIds: {
        type: 'string',
        description: '支撑这件事的 Source id，逗号分隔；不填会落一条模型自述来源（不能拿来证明自己）',
      },
      confidence: { type: 'string', enum: CONFIDENCE, description: '置信度，默认 medium' },
      disclosure: {
        type: 'string',
        enum: ['public', 'restricted', 'secret'],
        description:
          '披露等级，默认 public（普通记忆可被检索）。涉及隐私、账号、地址、健康等敏感内容时用 restricted 或 secret——' +
          'restricted/secret 不会被普通检索召回。',
      },
      opId: OP_ID,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        const lines = [`已记下事件 ${value.eventId}（${value.eventType}）。`]
        if (value.artifactId) {
          // 升格成功：把 revision / state / 独立证据数一次报全，模型下一轮引用时不用再 fetch。
          lines.push(
            `升成结论 ${value.artifactId} r${value.revision}（${value.artifactKind}/${value.state}），独立证据 ${value.independentEvidenceCount} 条。`,
          )
        } else if (value.promotion) {
          // 门槛不够：报「差什么」，并强调现有证据数，模型才知道下次该怎么补而不是硬重试。
          lines.push(
            `结论暂时不够格：需要 ${value.promotion.need}，现有独立证据 ${value.promotion.have?.independent ?? 0} 条。`,
          )
        }
        // 幂等重放要说破：否则模型会以为真的又写了一条，接着重复调用。
        if (value.replayed) lines.push('（这是 opId 重放，没有重复写入。）')
        return [{ type: 'text', text: lines.join('') }]
      },
    },
    execute: wrap((args) => {
      const input = asArgs<RememberInput>(args)
      return core.remember({ ...input, disclosure: disclosureOf(args, input.statement) })
    }),
  })

  // 记「撞车」事件：只落 Event，不动结论本身。要改结论必须走 review / revise，
  // 否则反证会让结论被隐式改写，审计链就断了——render 里那句提醒就是给模型看的边界。
  tools.clash = defineTool<ClashResult>({
    name: 'psyche_clash',
    description:
      '撞上一个跟已有结论对不上的事实，或一次真实分歧。给了 targetId（矛盾的结论 id）就记成 cognitive/contradiction_detected；' +
      '没给就记成 interaction/conflict。必须带 sourceIds：靠外部证据说话，不能拿模型自己的话当反证。' +
      '不要用它来「表达不同意见」——那是 conversation。',
    parameters: {
      targetId: { type: 'string', description: '被撞的 Artifact id（留空表示记一次人际冲突）' },
      text: { type: 'string', description: '撞在哪儿、反证是什么（≤500 字）' },
      sourceIds: { type: 'string', description: '反证来自哪些 Source，逗号分隔（必填）' },
      subject: { type: 'string', description: '涉及的 contactId / topic，逗号分隔' },
      confidence: { type: 'string', enum: CONFIDENCE, description: '默认 medium' },
      opId: OP_ID,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        // 有 target 时把 revision 一起带上：反证是针对「哪一版」的，后面复核要知道这一点。
        const target = value.targetArtifactId
          ? `针对 ${value.targetArtifactId} r${value.targetRevision}`
          : '（一次分歧）'
        return [
          {
            type: 'text',
            // 明确说「结论没被改动」：否则模型会以为 clash 已经把结论推翻了。
            text: `已记 ${value.type} ${value.eventId} ${target}；非自身来源 ${value.nonSelfSourceCount} 条。结论本身没被改动，要改请用 psyche_review / psyche_revise。`,
          },
        ]
      },
    },
    execute: wrap((args) => core.clash(asArgs<ClashInput>(args))),
  })

  // 改结论：两种语义共用一个工具（同 id 升版本 / supersedes 另起新结论），
  // 靠 artifactId / supersedes 二选一区分。两者都不给时 Core 会报 E_VALIDATION，本层不预判。
  tools.revise = defineTool<ReviseResult>({
    name: 'psyche_revise',
    description:
      '改一条已有结论。两种改法：给 artifactId = 同一件事说清楚了一点（revision+1，旧版本保留）；' +
      '给 supersedes = 换成另一句新结论（新 id，relations.supersedes 指回旧的）。' +
      'supersedes 也能指 Event id，用来把一条事件里的候选提升成正式结论。' +
      '必须带 refs：指回被改的那一句（事件 id 或主题），不要贴对话原文。',
    parameters: {
      statement: { type: 'string', description: '改完之后那句话是什么（≤2000 字）' },
      refs: { type: 'string', description: '这次修改依据的事件 id / 主题引用，逗号分隔（必填）' },
      artifactId: { type: 'string', description: '要改的 Artifact id（同 id 升版本）' },
      supersedes: { type: 'string', description: '要被取代的 Artifact id 或 Event id（另起新结论）' },
      kind: { type: 'string', enum: KIND_LIST, description: 'supersedes 新建时的类型，默认沿用旧的' },
      state: { type: 'string', description: '可选定新状态（不填沿用）' },
      sourceIds: { type: 'string', description: '额外证据 Source id，逗号分隔' },
      confidence: { type: 'string', enum: CONFIDENCE, description: '默认沿用旧值' },
      disclosure: {
        type: 'string',
        enum: ['public', 'restricted', 'secret'],
        description:
          '披露等级：不填就继承当前版本；只用它来显式收紧或放宽（会生成新 revision）。' +
          '普通内容修订不要顺手改披露等级。',
      },
      expectedRevision: {
        type: 'number',
        description:
          '可选乐观检查：你以为当前是第几版。不一致会返回 E_REVISION_CONFLICT，' +
          '说明别人刚改过——先重新读一遍再改，不要盲写覆盖。',
      },
      opId: OP_ID,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        // 同 id 改版：强调旧版本还在（审计可回溯），并说清「读的时候取哪一版」。
        if (value.mode === 'same-id') {
          return [
            {
              type: 'text',
              text: `已改 ${value.artifactId}：r${value.previousRevision} → r${value.revision}（${value.previousState} → ${value.state}）；旧版本仍保留，读的时候取 r${value.revision}。`,
            },
          ]
        }
        // supersedes 改版：来源可能是另一条结论，也可能是事件里的候选，两种都要说清楚。
        const from = value.supersedes ? `取代 ${value.supersedes}` : `源自事件 ${value.supersedesEvent}`
        return [
          {
            type: 'text',
            text: `已新建结论 ${value.artifactId} r${value.revision}（${value.kind}/${value.state}），${from}；独立证据 ${value.independentEvidenceCount} 条。`,
          },
        ]
      },
    },
    execute: wrap((args) => {
      // 披露等级只在显式给出时透传：不给就由 Core 继承当前 head，工具层不能替它改成 public。
      const input = asArgs<ReviseInput>(args)
      const explicit = (args as { disclosure?: unknown }).disclosure
      return core.revise(explicit === undefined ? input : { ...input, disclosure: disclosureOf(args) })
    }),
  })

  // 复核：五档状态机 + 一条 cognitive/review_result 事件。要求「非自身来源」，
  // 所以模型不能拿自己的判断当依据——给 sourceIds，或让触发事件本身来自用户。
  tools.review = defineTool<ReviewResult>({
    name: 'psyche_review',
    description:
      '复核一条结论是否还站得住，并决定它的状态。五档：confirmed 确认（受质疑的回到 active）/ refined 说得更准（补充表述）/' +
      'challenged 暂时存疑（标 challenged，不删）/ revised 已改（回到 active）/ rejected 推翻（fact 记 forgotten，其余 retracted）。' +
      '会被记成一条 cognitive/review_result 事件，所以要有非自身来源：给 sourceIds，或该结论的触发事件本身来自用户。' +
      '不要每轮都调——只在真的出现新信息时复核。',
    parameters: {
      artifactId: { type: 'string', description: '要复核的 Artifact id' },
      verdict: { type: 'string', enum: VERDICT_LIST, description: '复核判定' },
      note: { type: 'string', description: '一句话说明为什么（≤200 字）' },
      statement: { type: 'string', description: 'refined / revised 时的新表述；不填沿用原句' },
      sourceIds: { type: 'string', description: '复核依据的 Source id，逗号分隔；不填则回查该结论的触发事件' },
      confidence: { type: 'string', enum: CONFIDENCE, description: '默认沿用' },
      opId: OP_ID,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        // 把「上一版 → 新版」连状态一起报：rejected 时状态会变成 forgotten/retracted，
        // 模型需要看到这次落到了哪一档，才知道结论还能不能继续引用。
        return [
          {
            type: 'text',
            text: `复核完成：${value.artifactId} r${value.previousRevision}（${value.previousState}）→ r${value.revision}（${value.state}），判定 ${value.verdict}。`,
          },
        ]
      },
    },
    execute: wrap((args) => core.review(asArgs<ReviewInput>(args))),
  })

  // 认知遗忘：只追加一条状态版本，不删历史证据。检索侧按 head.state 过滤，
  // 所以 rebuild 也不会复活；彻底删除来源是另一条链，不在这个工具里。
  tools.forget = defineTool<ForgetResult>({
    name: 'psyche_forget',
    description:
      '把一条结论标成不再作为有效认知使用（认知遗忘）。只追加一条状态版本，不删历史证据；' +
      '普通检索不再召回它，rebuild 也不会复活。fact 记 forgotten，belief/impression/stance/relationship 记 retracted。' +
      '重复调用幂等。要重新启用必须走 psyche_revise 并显式恢复；彻底删除原始来源不在这个工具里。',
    parameters: {
      artifactId: { type: 'string', description: '要遗忘的 Artifact id' },
      reason: { type: 'string', description: '为什么不再用它（≤200 字，只进审计，不写进结论）' },
      opId: OP_ID,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        // 幂等重放要说破：否则模型会以为又追加了一版。
        if (value.alreadyForgotten) {
          return [{ type: 'text', text: `${value.artifactId} 已经是 ${value.state}（r${value.revision}），没有重复写入。` }]
        }
        return [
          {
            type: 'text',
            text: `已遗忘：${value.artifactId} r${value.previousRevision}（${value.previousState}）→ r${value.revision}（${value.state}）。历史证据仍在，普通检索不再召回它。`,
          },
        ]
      },
    },
    execute: wrap((args) => core.forget(asArgs<ForgetInput>(args))),
  })

  // 提议改设定：只能提「排队」，批准权在人。分区校验在 Core.propose 里，
  // growth / relationship / safety 一律 E_PARTITION——本层不预筛，好让模型拿到具体拒绝理由。
  tools.propose = defineTool<ProposeResult>({
    name: 'psyche_propose',
    description:
      '提一个改动心灵自身设定的建议（人格语气、习惯、偏好这类 life 参数）。提案只是排队，等人批准才生效——你不能自己改。' +
      '关系参数（好感/信任）和安全参数属于别人才能动的分区，提了也会被拒；不要尝试。',
    parameters: {
      partition: { type: 'string', enum: PARTITION_LIST, description: '参数分区，只有 life 可提' },
      target: { type: 'string', description: '改哪个参数/哪段设定' },
      change: { type: 'string', description: '改成什么' },
      rationale: { type: 'string', description: '为什么（会一起展示给人看）' },
      opId: OP_ID,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        return [
          {
            type: 'text',
            // 回「当前待批几条」：让模型知道这是队列而不是即时生效，减少重复提交同一个提案。
            text: `提案 ${value.proposalId} 已排队（${value.partition}: ${value.target}），等人批准才生效；当前待批 ${value.pendingProposals} 条。`,
          },
        ]
      },
    },
    execute: wrap((args) => core.propose(asArgs<ProposeInput>(args))),
  })

  // ── 只读 ──────────────────────────────────────────────────

  // 只读：看立场/结论。默认 kind=stance 是产品口径（「你怎么看」问的是立场，不是流水账），
  // state 默认 active+challenged 也在 Core 里定，这里只把「最多 50」写进描述。
  tools.stances = defineTool<StancesResult>({
    name: 'psyche_stances',
    description:
      '看心灵现在对某些事持什么立场（stance）以及别的活着的结论。默认只看 stance；要别的类型就传 kind。' +
      '用户问「你怎么看…」「我们之前定的…」时用它，不要凭印象编。',
    parameters: {
      kind: { type: 'string', enum: KIND_LIST, description: '结论类型，默认 stance' },
      subject: { type: 'string', description: '按 subjectRefs 过滤，例某人的 contactId 或话题名' },
      state: { type: 'string', description: '状态过滤，逗号分隔；默认 active+challenged' },
      limit: { type: 'number', description: '默认 10，最多 50' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        if (!value.items.length) return [{ type: 'text', text: '目前没有这类结论。' }]
        // 一行一条：id/版本/类型/状态/证据数 + 陈述。证据数放在最前面是为了让模型一眼看出哪条「立得住」。
        const lines = value.items.map(
          (item) =>
            `- [${item.artifactId} r${item.revision} ${item.kind}/${item.state} 证据${item.independentEvidenceCount}] ${item.statement}`,
        )
        // total 与 items.length 可能不同（limit 截断），所以标题用 total 说总数。
        return [{ type: 'text', text: `${value.total} 条：\n${lines.join('\n')}` }]
      },
    },
    execute: wrap((args) => core.stances(asArgs<StancesQuery>(args))),
  })

  // 自身状态：一次把人格/阶段/规模/存储健康吐全，用来回答「怎么没记住」这类排查问题。
  // 注意 storage 里的字段来自 db.health()（会跑 PRAGMA + statSync），所以别鼓励高频调用。
  tools.state = defineTool<StateResult>({
    name: 'psyche_state',
    description:
      '看心灵自己的状态：人格配置、当前自我认知、成长阶段，以及库里的规模（事件/结论/操作/待批提案/QQ 待处理）。' +
      '开场想确认「我在什么阶段」或者排查「怎么没记住」时用。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        const c = value.counts
        const s = value.storage
        // 三段式：人格/阶段 → 各表规模 → 存储健康。中间用 \n 分节，避免长文本糊成一段。
        return [
          {
            type: 'text',
            text:
              `人格 ${value.persona.id}（${value.persona.type}），阶段 ${value.phase.phase}（自 ${formatDateTime(value.phase.since, '未知')}）。\n` +
              `库：源 ${c.sources} / 事件 ${c.events} / 结论 ${c.artifacts}（版本 ${c.revisions}）/ 操作 ${c.operations} / 提案 ${c.proposals} / QQ 待处理 ${c.pendingWrites}。\n` +
              `存储：${s.driver}，user_version=${s.userVersion}，表 ${s.tables} 张，journal=${String(s.journalMode)}，${s.bytes} 字节，慢查询 ${s.slowQueries} 次（最慢 ${s.maxQueryMs}ms）。`,
          },
        ]
      },
    },
    execute: wrap(() => core.getState()),
  })

  // 最小上下文：开场/换话题用，刻意比 state 窄（阶段、自我、已立住的判断、最近变化 + 一句 note），
  // 为的是不把整个库塞进上下文；细节留给 recall / stances / fetch。
  tools.context = defineTool<ContextResult>({
    name: 'psyche_context',
    description:
      '开场或换话题时取「此刻的她」：当前阶段、自我认知、几条已经立住的判断。' +
      '这是最小上下文，细节用 psyche_recall / psyche_stances / psyche_fetch 取。' +
      '不要为了凑信息每轮都调，也别把里面的阶段当成任务清单去推进。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        const lines = [`阶段：${value.persona.stageLabel}（${value.persona.stage}）。`]
        // self 可能为空串（还没形成自我认知），空就别输出一行空的「此刻的我：」。
        if (value.self) lines.push(`此刻的我：${value.self}`)
        if (value.beliefs.length) {
          lines.push('已经立住的判断：')
          for (const belief of value.beliefs) lines.push(`- ${belief.statement}（${belief.artifactId}）`)
        } else {
          // 明确说「还没有」而不是省略这一段：模型会据此决定要不要去 remember，而不是误以为字段丢了。
          lines.push('还没有立住的判断。')
        }
        if (value.recentCognitiveChanges.length) {
          lines.push('最近的变化：')
          for (const change of value.recentCognitiveChanges) {
            lines.push(`- ${change.statement || change.type}（${formatDateTime(change.at)}）`)
          }
        }
        // 批准的自我调整不进配置，只能从这段回到上下文——漏了这段，批准就等于没批（见 proposals.ts 文件头）
        if (value.recentApprovals.length) {
          lines.push('最近批准的自我调整：')
          for (const item of value.recentApprovals) {
            lines.push(`- ${item.target}：${item.change}（${formatDateTime(item.at)}）`)
          }
        }
        // note 是 Core 给的收尾提示（例如「别每轮都取」），永远放最后一行。
        lines.push(value.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: wrap(() => core.context()),
  })

  // 关系视图：只读，且刻意只给档位不给分数——好感分属于内部量，念出来会变成可优化的指标。
  // contactId 不填时 Core 会把 undefined 当「没有指定的人」处理（E_VALIDATION），本层不兜。
  tools.relationship = defineTool<RelationshipResult>({
    name: 'psyche_relationship',
    description:
      '看心灵和某个人的关系：亲近档位、信任结论、最近的信号与情绪维度。' +
      '好感只以档位表达（不报具体分数、不对外念分数）；要自然地说「我们挺熟的」，不要报数字。',
    parameters: {
      contactId: { type: 'string', description: 'Contact id（ct_ 开头）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        const who = value.contact.displayName || value.contact.contactId
        // 第一行就把档位说清（bandLabel 是人话，band 是内部枚举），后面各段按有无数据追加。
        const lines = [`${who}：关系档位「${value.affinity.bandLabel}」（${value.affinity.band}）。`]
        lines.push(
          // 没有信任结论时明确说「还没有」，别让省略变成「没这段」。
          value.trust
            ? `信任结论：${value.trust.statement}（r${value.trust.revision}/${value.trust.state}）`
            : '还没有关于信任的结论。',
        )
        if (value.affect.length) {
          lines.push(`情绪维度：${value.affect.map((a) => `${a.dimension}=${a.value}`).join('，')}`)
        }
        lines.push(
          `信号账本：${value.signals.total} 条${value.signals.recent.length ? `，最近 ${value.signals.recent[0]!.signalType}` : ''}。`,
        )
        lines.push('（好感分不公开，只说档位。）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: wrap((args) => core.getRelationship(asArgs<{ contactId?: string }>(args).contactId)),
  })

  // 召回：按线索找「记下了什么」。R3 起与自动注入共用 FTS5 + BM25 + 状态/披露/Scope/Subject
  // 准入（过滤全在 LIMIT 之前）；事件只给非敏感摘要（类型 + 时间），不再返回原文——要原话得用
  // fetch 按 id 取。Scope 只能由宿主从 RuntimeInput 注入，模型参数进不到这里。
  tools.recall = defineTool<RecallResult>({
    name: 'psyche_recall',
    description:
      '按线索找回旧事：记下了什么（结论）+ 关联事件摘要（只给类型和时间，不返回原文）。' +
      '用户说「还记得…吗」「上次那个…」时用。用具体词（人名、项目名、术语）查，比泛泛的关键词准。' +
      '结论带支持证据数与争议标记；要原话再用 psyche_fetch 按 id 取。' +
      '没有可用记忆时返回 abstained=true 和固定提示——不要据此编造「记得」。',
    parameters: {
      text: { type: 'string', description: '线索词：人名/项目/术语' },
      kind: { type: 'string', enum: KIND_LIST, description: '只查某类结论' },
      subject: { type: 'string', description: '按 subjectRefs 精确过滤（不是子串）' },
      limit: { type: 'number', description: '结论条数，默认 8，最多 20' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        // R4-A：abstention 不是「成功但空列表」，必须回显固定提示，不能显示成普通结果。
        if (value.abstained) {
          return [{ type: 'text', text: value.guidance ?? '这次没有找到可用的记忆。' }]
        }
        const out: string[] = []
        if (value.results.length) {
          out.push('结论：')
          for (const item of value.results) {
            // challenged 必须把争议带出来：只在自动注入时处理争议，等于让主动回忆把猜测当事实。
            const note = item.statusNote ? `（${item.statusNote}）` : ''
            const evidence = item.supportEvidenceCount > 0 ? `，支持证据 ${item.supportEvidenceCount}` : ''
            out.push(`- [${item.artifactId} r${item.revision} ${item.kind}/${item.state}] ${item.statement}${note}${evidence}`)
          }
        }
        // 事件只给「类型 + 时间」：R3 收窄为关联摘要，原文由 fetch 按 id 取。
        const withEvents = value.results.filter((item) => item.relatedEvents.length > 0)
        if (withEvents.length > 0) {
          out.push('关联事件（摘要）：')
          for (const item of withEvents) {
            const events = item.relatedEvents.map((event) => `${event.type}@${formatDateTime(event.at)}`).join('、')
            out.push(`- ${item.artifactId}：${events}`)
          }
        }
        if (out.length === 0) return [{ type: 'text', text: '没有找到相关的记忆。' }]
        return [{ type: 'text', text: out.join('\n') }]
      },
    },
    execute: async (args: unknown, exec?: unknown) => {
      // Scope 只来自宿主：exec.agent → RuntimeInputStore 的会话绑定；取不到就只给全局记忆。
      try {
        const scope = options.recallScope?.(exec) ?? {}
        return jsonSafe(await core.recall(asArgs<RecallQuery>(args), scope)) as unknown as RecallResult
      } catch (error) {
        return { ...toErrorPayload(error) } as unknown as RecallResult
      }
    },
  })

  // 按 id 取原文：ids 混着 src_/evt_/art_ 三种前缀也没关系，Core 按前缀分派。
  // budget 是「总字符预算」，截断在 Core 里做，这里的 truncated 只是告诉模型被截了。
  tools.fetch = defineTool<FetchResult>({
    name: 'psyche_fetch',
    description:
      '按 id 取原文：Source（原话）、Event（事件）、Artifact（结论）。召回只给片段，要原话时才用它。' +
      '预算有限，只取真正需要的几条。',
    parameters: {
      ids: { type: 'string', description: 'src_/evt_/art_ id，逗号分隔' },
      budget: { type: 'number', description: '总字符预算，默认 2000，最多 8000' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const fail = failed(value)
        if (fail) return fail
        const blocks = value.items.map((item) => {
          // missing 是正常结果（id 过期/写错），用一行「找不到」占位而不是跳过，保持与 ids 一一对应。
          if (item.type === 'missing') return `${item.id}：找不到。`
          return `【${item.type} ${item.id} ${formatDateTime(item.at)}】\n${item.text}`
        })
        // 截断必须说破：否则模型会把「没看到后半句」当成「原文就这么多」。
        const tail = value.truncated ? `\n（已按 ${value.budget} 字预算截断）` : ''
        return [{ type: 'text', text: `${blocks.join('\n\n') || '没有内容。'}${tail}` }]
      },
    },
    execute: wrap((args) => {
      const input = asArgs<{ ids?: string; budget?: number }>(args)
      return core.fetch(input.ids, input.budget)
    }),
  })

  // 返回顺序 = 模型侧工具表顺序：五写在前、读在后。
  // 增删工具时要同时改这里和 index.ts 的桥接对象，否则工具表与实现会静默错位。
  return [
    tools.remember,
    tools.clash,
    tools.revise,
    tools.review,
    tools.forget,
    tools.propose,
    tools.stances,
    tools.state,
    tools.context,
    tools.relationship,
    tools.recall,
    tools.fetch,
  ]
}

