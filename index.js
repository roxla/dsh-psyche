// 宿主的 cordis loader 对 bundle patch 里的裸包名会去包根找 index.js，
// 而真正的入口在 dist/。这个薄壳只做转发，顺带让浏览器半侧（dsh.client）
// 能挂在「说明符恰为裸包名」的那一行上（官方 cookbook/adding-a-settings-card.zh.md:58）。
export { default } from './dist/index.js'
export * from './dist/index.js'
