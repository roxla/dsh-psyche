# Psyche 迁移报告（PSY-M1~M3）

## 目的

把已验证的插件产品代码迁移到独立公开仓 `dsh-psyche`，完成命名空间、数据归属门禁、旧注入标记兼容与构建测试，不修改内部验证仓、Host 或 Schema。

## 基线

- 源冻结提交：`06d6e06`（内部验证仓，DEV v28.79）。
- 源基线：5813 断言 / 184 套件 / 185 步 / 0 失败；Schema v31 / 70 表 / 40 触发器。
- 目标仓起始提交：`5baf0c1`（仅 LICENSE）。

## 迁移结果

- 复制 533 个文件，改写 372 个文件；排除 `node_modules`、`dist`、`.git`、`main`、回收站、历史 audit 证据、旧 DEV 快照和 `package-lock.json`。
- 产品树：`src/`、`packages/`、`test/`、`presets/`、`locale/`、`tools/`、`docs/design/`、`assets/echarts.min.js` 及根配置。
- 命名：根包 `dsh-psyche`；workspace 包 `dsh-psyche-contract/core/qq/pet/web/ops`；服务 `ctx.psyche`；12 个 `psyche_*` 工具；API `/api/psyche/*`；默认数据目录 `$DSH_HOME/psyche`；备份格式 `psyche-archive`；日志前缀 `[psyche]`。
- 保留：`memory.sqlite3`、`identity.md`、`persona.json`、`personaId=main`、Schema/数据表/错误码、Host Section/事件/Slot 名、`DSH_HOME`、`@deepseek-ai/*`。
- 旧品牌只保留只读识别：捕获层可识别 `source.lingban` 与 `msg_lingban_` 以排除历史注入；新写入只用 `source.psyche` / `msg_psyche_`。
- 数据门禁：数据根必须存在 `product.json`，内容为 `{"product":"dsh-psyche","formatVersion":1}`；空目录原子初始化；无标识的非空目录、其他产品标识、损坏 JSON 一律拒绝；旧 `lingban-archive` 不自动接受。
- 公开仓清理：移除旧仓库绝对路径、机器用户名、真实 QQ 测试标识、历史性能数据与旧品牌包名前缀。

## 验证

- `pnpm install`：成功。
- `pnpm run workspace:typecheck`：通过。
- `pnpm run build`：通过。
- `pnpm run test:all`：退出码 0。
- 迁移后基线：**5826 断言 / 185 套件 / 186 步 / 0 失败**。
- 新增：`product-isolation` 8 断言；旧来源标记回归 5 断言（capture-host 2、mood-wiring 2、remember-button 1）。
- 全量测试包含 12 工具清单、数据门禁、旧标记过滤、备份/恢复、Schema v31 与所有既有回归。

## 未完成

- M4 隔离 Host 安装/卸载/客户端页面/工具调用：NOT VERIFIED。
- M5 干净 clone 构建与发布产物（不依赖 workspace 软链）：NOT VERIFIED。
- 真实 QQ 平台与模型行为：NOT VERIFIED；迁移不改变既有 PARTIAL/BLOCKED 结论。
- Host 认证、生命周期与 Provider 边界仍按内部验证仓的既有结论执行。

## 结论

PSY-M1~M3 **PASS**（构建与自动化测试范围）；M4/M5 **NOT VERIFIED**；整体迁移仍为 **PARTIAL**，不得据此宣称 Host 或发布验收通过。
