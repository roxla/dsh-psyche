# AGENTS.md — dsh-psyche

本仓库是 Psyche（心灵）的公开产品仓。开发与实验在内部验证仓完成；本仓库只接收经过审查、命名适配和测试的产品变更。

## 权威顺序

1. 本文件：工程约束。
2. `dsh-psyche-DEV.md`：唯一设计/基线权威。
3. `docs/design/`：已冻结设计。
4. `docs/audit/`：迁移与验收报告（只放产品相关结论，不搬旧仓库原始证据）。

## 硬规则

- 单人格 `main`；SQLite 唯一事实源；append-only 证据；Scope 最小披露。
- Schema 版本、数据表字段、Host Section/事件/Slot 名不得因品牌改名而变化。
- 不注册旧品牌兼容别名（`ctx.lingban`、旧工具、旧 API、旧 env、旧数据目录、旧备份格式）。
- 数据目录必须先通过 `product.json` 归属门禁，再打开 SQLite。
- 不修改 DeepSeek Harness、Host、`DSH_HOME`、`@deepseek-ai/*`、`qq-snowluma`、`host-desktop`。
- 默认保持安全关闭：`persona.dominance=false`、QQ 群生产回复禁用、Reply Outbox 关闭、Intention Projection 关闭、意识海默认隐藏。
- 改名不得扩大工具权限；旧白名单/审批结果不能自动视为新插件授权。

## 一轮完成

```powershell
pnpm install --frozen-lockfile
pnpm run workspace:typecheck
pnpm run build
pnpm run test:all
```

代码改动必须同时更新 DEV；涉及发布/安装/数据目录时更新 README；报告写入 `docs/audit/`。Host 缺能力或未实测的项目记 PARTIAL / NOT VERIFIED，不写 PASS。

## Windows

- 不要用 PowerShell 5.1 `Get-Content` / `Set-Content -Encoding utf8` 改含中文文件。
- 删除走工作区提供的安全删除工具，不直接 `Remove-Item`。
- `node -e` 可能被安全网关拦截；临时脚本写成 `.mjs` 文件再运行。
