// 心灵 · 浏览器半侧：前置声明（宿主契约、常量、全局句柄）
//
// 运行环境：脚本式 bundle、不是 ESM。宿主 web app 用 window.__ModuleLoader__.load 装载，
// factory 收到一个 require（react 由宿主提供），所以全文没有 import/export、也不写 JSX：
// React 用 req('react') 取，元素一律 h = React.createElement 造。
//
// 全局访问统一走 globalThis（下面存成 host / browser），不直接写 window / fetch / setInterval——
// 这样不依赖 DOM 类型，Node 侧（无 DOM lib）也能做语法与类型检查。
//
// 拆分约定：本目录下每个 .ts 都是同一个 bundle 的片段，按 tsconfig.client.json 的 files 顺序拼接。

/** 宿主装载前注入的全局 require；浏览器侧只保证能解析 react，别的一律不碰。 */
declare function require(id: string): any

/** __ModuleLoader__.load 的参数：id 是插件模块名，factory 返回插件对象。 */
interface ModuleLoaderSpec {
  id: string
  factory: (req: (id: string) => any) => unknown
}
/** 只声明宿主 window 上我们真正用到的那点表面，不跟宿主类型体系耦合。 */
interface LoaderWindow {
  __ModuleLoader__?: { load(spec: ModuleLoaderSpec): void }
  setInterval?: (handler: () => void, timeout?: number) => number
  clearInterval?: (handle: number) => void
}

// 侧栏图标与主面板页面共用同一个 id：宿主据此把「点图标」和「开哪页」对上。
const MODULE_ID = 'dsh-psyche'
const PANEL_ID = 'psyche'
// 侧栏排序值：宿主自带面板占 0 起的一段，32 让心灵排在它们后面但不掉队尾。
const PANEL_ORDER = 32
// 轮询间隔。都是只读快照，20 秒足够；再快只会白刷数据库。
const POLL_MS = 20000

const host: any = globalThis as any
// 测试/无头环境下没有 window，就退回 globalThis 自己，避免读到 undefined。
const browser: any = host.window ?? host
const loader = browser.__ModuleLoader__ as { load(spec: ModuleLoaderSpec): void } | undefined

// 由 index.ts 在 factory 里赋值：所有页签组件都通过这两个句柄建元素。
let React: any = null
let h: any = null
// 错误边界是 class 组件，等 React 到位后再由 createPageBoundary() 建出来。
let PageBoundary: any = null
