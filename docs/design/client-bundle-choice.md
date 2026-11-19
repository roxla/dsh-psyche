# 客户端半侧：脚本式 bundle 还是 ESM bundle

状态：**决定维持现状，并立下迁移触发条件**
日期：2026-11-08
适用：`src/client/index.ts`（宿主 Web 界面里的侧栏面板与对话操作按钮）

## 1. 问题

心灵的客户端半侧有两套可行做法：

- **脚本式 bundle**（当前）：`window.__ModuleLoader__.load(id, factory)`，factory 收到一个
  `require`（宿主只保证能解析 `react`）；全文无 `import`/`export`、无 JSX，元素用
  `React.createElement` 构造。
- **ESM bundle**（dsh-mnemon 的做法）：用打包器产出 ESM，裸导入
  `@deepseek-ai/dsh-client-ui-primitives`（`Tooltip` / `Button` / `Modal` / `Select`），
  可以写 JSX 与 CSS modules。

两者都能被宿主加载，差别在**能用到什么**和**要付什么成本**。

## 2. 对比

| 维度 | 脚本式 bundle（当前） | ESM bundle |
| --- | --- | --- |
| 构建 | 无打包步骤，`tsc` 只做类型检查 | 多一步打包（tsdown / esbuild） |
| 宿主组件 | 只能 `require('react')` | `Tooltip` / `Button` / `Modal` 等直接用 |
| 主题与视觉 | 全自绘，深色适配靠自己 | 跟宿主一致（主题 token） |
| JSX / CSS modules | 不支持 | 支持 |
| 复杂交互（模态、下拉、Toast 队列） | 手写，容易出层级/裁剪问题 | 直接用宿主实现 |
| 宿主内部包变化 | 不受影响 | 受影响（primitives 导出变了会炸） |
| 安装时依赖 | 无 | 打包器（devDependency） |
| 大文件维护 | 差（现有约 5400 行） | 好 |

**已经付过一次代价**：「记住这条」的 tooltip 原先是按钮旁边的 `absolute` 元素，
被消息操作行的 `overflow: hidden` 裁掉，调 `z-index` 无效。最终改成挂到
`document.body` 的 `fixed` 浮层才解决——这正是「拿不到宿主 Tooltip」的直接成本。

## 3. 决定

**现在不迁移。** 理由：

1. 客户端目前是「一个侧栏面板 + 一个对话操作按钮」，自绘还能撑住；
2. 迁移要动 5400 行、引入打包链、重新验证宿主的两条加载路径（`exports["./client"]`
   与 `__ModuleLoader__`），风险高于收益；
3. 当前真正的风险在服务端语义（披露、Scope、注入边界），不在 UI 技术栈。

## 4. 迁移触发条件

以下任意两条命中，就启动迁移：

- UI 代码继续增长到约 6000 行以上，或需要「模态框、下拉、Toast 队列」这类复杂交互；
- 需要与宿主视觉逐像素一致（P3 状态页、Grant 授权界面会逼到这个）；
- 宿主升级后，自绘组件开始与新版样式打架（层级、圆角、字体、暗色适配）。

按现有路线图，**C 阶段（主 profile 决策 → 注入块折叠 → Grant 授权 UI）大概率会触发**：
Grant 授权是个正经交互界面，自绘不划算。

## 5. 如果迁移，怎么做

只迁客户端，服务端不动：

1. 新建 `packages/client`（workspace 子包），用 `tsdown` 或 `esbuild`；
2. `externals` 声明 `react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`
   ——由宿主提供，不打进产物；
3. 输出 ESM 到 `dist/client/index.js`，`package.json` 的 `exports["./client"]` 指向它；
4. 现有面板逻辑先原样搬（`React.createElement` 在 ESM 里也能用），再逐块换成
   JSX + 宿主组件；
5. 过渡期保留两份：脚本版兜底、ESM 版默认，`test/check-client.mjs` 两边都跑。

## 6. 一句话

当前结构是「够用且零依赖」的合理选择，不是最优解；等 C 阶段把 UI 复杂度抬上来再迁，
代价最小。
