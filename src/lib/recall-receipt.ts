// R4-B：Recall Receipt 的根包再导出壳。
//
// core 包（`dsh-psyche-core`）是唯一实现；这里只为 `dist/lib/*` 的
// 既有引用路径保留入口，避免宿主侧 import 直接指到 core 的内部文件。
export * from 'dsh-psyche-core'
