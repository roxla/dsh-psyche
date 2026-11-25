# dsh-psyche-DEV — 心灵 · Psyche 设计与迁移基线

版本：v1.0（PSY-M0~M6）
状态：PSY-M1~M3 已完成；M5 干净 clone 构建已通过；M4 隔离 Host 与空数据根已实测通过（2026-11-25，`docs/audit/psy-m4.md`），M4 的发布包安装路径仍未验。冻结方案见 GPT 评审记录（M01–M10）；迁移报告见 `docs/audit/psy-m1-m3.md`。

## 1. 定位

Psyche 是 DeepSeek Harness 的心智系统插件，不是单纯记忆插件。它把人格、记忆、关系、情绪、成长、意愿与捕获链路放在同一套 SQLite 事实源上，并通过单一人格 `main` 约束表达。

内部验证仓保留为开发与实验源；本仓库只接收已验证、命名适配、通过 `test:all` 的产品变更。

## 2. 不可变边界

- Schema 版本、数据表/字段名、Host Section/事件/Slot 名、`DSH_HOME`、`@deepseek-ai/*`、`qq-snowluma`、`host-desktop`。
- `memory.sqlite3`、`identity.md`、`persona.json`、`personaId=main`。
- `E_*` / `GROUP_*` 错误码语义。
- 不注册旧品牌兼容别名；旧 `source.lingban` 只在捕获层做只读识别。

## 3. 命名空间

| 项目 | 名称 |
| --- | --- |
| 仓库/根包 | `dsh-psyche` |
| workspace | `dsh-psyche-contract/core/qq/pet/web/ops` |
| 服务 | `ctx.psyche` |
| 工具 | 12 个 `psyche_*` |
| API | `/api/psyche/*` |
| 数据目录 | `$DSH_HOME/psyche` |
| 数据库 | `memory.sqlite3` |
| 备份格式 | `psyche-archive` |
| 中文名 | 心灵 |
| 意识海 | Mind Sea |

## 4. 数据归属门禁

数据目录根部 `product.json`：

```json
{ "product": "dsh-psyche", "formatVersion": 1 }
```

`ensureProductDataDir()` 在写 config-audit、应用恢复、打开 SQLite 之前执行：

- 空目录：写入标识后初始化。
- 标识一致：继续。
- 旧目录 / 已有数据库但无标识 / 标识损坏 / 版本不符：抛错拒绝启动。
- 旧 `lingban-archive` 不自动接受；标识不承担 Owner 认证。

## 5. 迁移分期

- PSY-M0 源基线冻结：内部验证仓 HEAD `06d6e06`，DEV v28.79，5813/184/185/0，Schema v31/70 表/40 触发器；`dsh-psyche` 初始提交 `5baf0c1`。
- PSY-M1 产品树复制与开源清理：533 文件，排除 node_modules/dist/.git/main/_回收站/历史证据；新增公开 README/AGENTS/DEV/第三方许可。
- PSY-M2 命名空间重构：包名、服务、类型/事件/常量、12 工具、API、客户端 Module/Panel、Section/Context、来源标记、CLI、备份/日志前缀。
- PSY-M3 构建与全量测试：`workspace:typecheck`、`build`、`test:all`。
- PSY-M4 隔离 Host：独立 DSH Home 与空数据根，确认旧 Lingban 不同 Profile 启用、QQ 默认不连接。
- PSY-M5 发布安装：干净 clone 构建；发布产物不依赖 workspace 软链。
- PSY-M6 文档与分段提交：不压成单条大提交，不自动推送远程。

## 6. 验收状态

- 迁移前基线：5813 断言 / 184 套件 / 185 步 / 0 失败。
- 迁移后基线：5826 断言 / 185 套件 / 186 步 / 0 失败（`test:all` 通过；含 `product-isolation` 8 与旧来源标记回归 5）。
- 干净 clone 构建：`pnpm install --frozen-lockfile` 与 `pnpm run build` 通过；`build` 先构建全部 workspace 包，再编译根入口。
- 真实 Host 安装、侧栏/工具/API、QQ 隔离环境、发布产物：NOT VERIFIED，直到逐项实测。
- 安全默认值保持：`persona.dominance=false`、群生产回复 DISABLED、Reply Outbox false、Intention Projection false、意识海默认隐藏。
