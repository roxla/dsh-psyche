/**
 * 兼容层：早期代码用 `PsycheCore`，D1-1 起契约的正名是 `CoreApi`。
 * 这里只做别名与 health 的补充，不再重复声明方法签名。
 */
import type { CoreApi, CoreHealth } from './api.js'

/** 等价于 CoreHealth，保留旧名以免通道包先编译不过。 */
export type PsycheCoreHealth = CoreHealth

/** Core 的公共面 = CoreApi + 健康探活。 */
export interface PsycheCore extends CoreApi {
  health(): Promise<CoreHealth>
}
