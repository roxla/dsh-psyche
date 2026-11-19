// 宿主（DeepSeek Harness / cordis）侧的类型声明——纯 ambient，编译后不产生任何运行时代码。
// 这些包在运行时由宿主解析，工作区里既没有 node_modules 也没有 .d.ts，
// 所以这里按插件实际用到的 API 写最小声明：
//   - @deepseek-ai/cordis         Service / Context / 生命周期
//   - @deepseek-ai/dsh-tools      defineTool 与工具契约
//   - @deepseek-ai/schemastery    配置 schema
//   - @deepseek-ai/dsh-home-paths 数据根目录解析
// 只声明用到的那一面；改这里等于改与宿主的契约，宁可少声明也不要写宽（写宽会掩盖真错）。

declare module '@deepseek-ai/cordis' {
  /** 宿主注入的日志器；四个方法全部可选（测试替身常常只实现一部分）。 */
  export interface Logger {
    debug?(message: string): void
    info?(message: string): void
    warn?(message: string): void
    error?(message: string): void
  }

  export type EffectCallback = () => (() => void) | void

  export interface PromptSectionOptions {
    name: string
    order?: number
    text: () => string
    interpolate?: boolean
  }

  /** 装配上下文：DSH 在 `dsh-agent` 里补了 `agent`（按装配的 Agent）；诊断/非会话时缺省。 */
  export interface PromptContextAssembly {
    agent?: { id?: string; session?: { id?: string } }
  }

  /** 一段动态 Context：`text()` 每次装配求值，写成宿主侧 user-role 快照。 */
  export interface PromptContextOptions {
    name: string
    order?: number
    text: (context: PromptContextAssembly) => string
  }

  /** 系统提示的一段：`text()` 是惰性求值——每轮拼提示时才调用，所以能读到最新状态。 */
  export interface SystemPromptService {
    section(options: PromptSectionOptions): () => void
    context(options: PromptContextOptions): () => void
  }

  export interface HttpResponse {
    statusCode: number
    setHeader?(name: string, value: string): void
    end?(body?: string): void
  }

  export interface HttpRequest {
    method?: string
    url?: string
    headers?: Record<string, string | string[] | undefined>
    /** Node IncomingMessage 的流接口；宿主也可能直接给出解析好的 body。 */
    body?: unknown
    on?(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): void
  }

  /** 一条 HTTP 路由。`kind` 决定精确匹配还是前缀匹配；返回值被忽略，响应要写进 `response`。 */
  export interface HttpRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler(request: HttpRequest, response: HttpResponse): Promise<void> | void
  }

  /** 挂 Web 路由的服务；`register` 返回注销函数，插件卸载时调用。 */
  export interface WebServerService {
    register(route: HttpRoute): () => void
  }

  export interface ToolTextBlock {
    type: 'text'
    text: string
  }

  export type ContentBlock = ToolTextBlock | { type: string; [key: string]: unknown }

  /** 注册工具的服务；返回注销函数（也可能什么都不返回，所以返回值是可选的）。 */
  export interface ToolsService {
    register(tool: unknown): (() => void) | undefined
  }

  export interface ServiceMap {
    systemPrompt: SystemPromptService
    webServer: WebServerService
    tools: ToolsService
  }

  /**
   * cordis 的插件上下文。
   *
   * 服务一律可空：`systemPrompt` / `webServer` 缺了插件就降级，只有 `tools` 是硬依赖。
   * `effect(cb)` 注册副作用，返回的清理函数由宿主在卸载时调用——别在插件里自己 `process.on`。
   * `inject(deps, cb)` 等依赖就绪再执行回调；`get(key)` 是软取，拿不到服务返回 undefined。
   */
  export interface Context {
    logger?: Logger
    systemPrompt?: SystemPromptService
    webServer?: WebServerService
    tools: ToolsService
    /** 软取服务：宿主没有这个服务时返回 undefined（dsh-mnemon 同款用法）。 */
    get?<T = unknown>(key: string): T | undefined
    effect(callback: EffectCallback, label?: string): void
    plugin(plugin: unknown, config?: unknown): void
    inject<K extends keyof ServiceMap>(deps: readonly K[], callback: (ctx: Context & Pick<ServiceMap, K>) => void): void
    on(event: string, listener: (...args: unknown[]) => unknown): () => void
  }

  /** 服务基类：插件要暴露服务时继承它，构造时把 `ctx` 与 `name` 交给宿主登记。 */
  export class Service {
    protected constructor(ctx: Context, name: string)
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /** defineTool 的参数 DSL（DSH 方言：每个键描述一个入参）。 */
  export interface ToolParameter {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object'
    description?: string
    enum?: readonly string[]
    required?: boolean
    items?: unknown
    properties?: Record<string, unknown>
  }

  export type ToolParameters = Record<string, ToolParameter>

  export interface ToolRunContext {
    signal?: AbortSignal
  }

  /** 工具输出契约：`render` 决定面板/终端里怎么显示，`presentationMeta` 给结构化展示层。 */
  export interface ToolOutput<Result> {
    schema: { type: 'json' } & Record<string, unknown>
    render(args: unknown, value: Result): import('@deepseek-ai/cordis').ContentBlock[]
    presentationMeta?(args: unknown, value: Result): unknown
  }

  /** 一个工具的定义。`timeoutMs` / `isConcurrencySafe` 不填就是宿主默认（串行、无超时）。 */
  export interface ToolDefinition<Result = unknown> {
    name: string
    description: string
    parameters: ToolParameters
    output: ToolOutput<Result>
    execute(args: unknown, exec?: ToolRunContext): Promise<Result>
    timeoutMs?: number
    isConcurrencySafe?: boolean
  }

  /**
   * 只用来校验形状并推导 Result：渲染函数拿到的 value 与 execute 的返回同型。
   * 工具失败时返回 { ok:false, code, error }，由 render 里的 failed() 分流。
   */
  export function defineTool<Result>(definition: ToolDefinition<Result>): ToolDefinition<Result>
}

declare module '@deepseek-ai/schemastery' {
  /** 配置 schema 的链式接口；`default()` 会改变推导出的类型（默认值让输出不再是可选）。 */
  export interface Schema<T> {
    (value: unknown): T
    default<D extends T>(value: D): Schema<D>
    description(text: string): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
    step(value: number): Schema<T>
  }

  export type InferSchema<S> = S extends Schema<infer T> ? T : never

  /** schema 工厂：只声明插件用到的几个构造器（object / boolean / string / number / 数组 / 常量）。 */
  export interface Schemastery {
    object<S extends Record<string, Schema<any>>>(shape: S): Schema<{ [K in keyof S]: InferSchema<S[K]> }>
    boolean(): Schema<boolean>
    string(): Schema<string>
    number(): Schema<number>
    /** 非负整数（Schemastery 的 `.natural()`）。 */
    natural(): Schema<number>
    array<T>(inner: Schema<T>): Schema<T[]>
    const<T>(value: T): Schema<T>
  }

  const z: Schemastery
  export default z
}

declare module '@deepseek-ai/dsh-home-paths' {
  /** 宿主数据根目录（插件的 memory 库与 backups 都放在它下面）。 */
  export function resolveDshHome(): string
}
