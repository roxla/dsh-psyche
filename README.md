# 心灵 · Psyche

> 不止于记忆，也不止于人格。记得过去，感受当下，成长为自己。

Psyche 是 DeepSeek Harness 的心智系统插件：单一人格、可修订记忆、SQLite 唯一事实源，并提供关系、情绪、成长、意愿与意识海页面。

它源自内部验证分支，只接收经过审查、命名适配与测试的产品变更。

## 能力

- 十二个模型工具：`psyche_remember`、`psyche_clash`、`psyche_revise`、`psyche_review`、`psyche_forget`、`psyche_propose`、`psyche_stances`、`psyche_state`、`psyche_context`、`psyche_relationship`、`psyche_recall`、`psyche_fetch`。
- `ctx.psyche` 服务与 `/api/psyche/*` 只读/受控写接口。
- 侧栏页面：概览、记忆、情绪、QQ、设置，以及意识海 Mind Sea。
- 单人格 `main`、append-only 证据、Scope 最小披露、可修订结论。

## 安装

要求：DeepSeek Harness、Node.js >= 24.9.0、pnpm。

```powershell
pnpm install
pnpm run build
```

将本仓库作为插件加入目标 DSH Profile，或在 Profile 的插件配置中引用包根。`cordis.patch.yml` 使用裸包名 `dsh-psyche`；不要改成 `./dist/index.js`，否则浏览器半侧不会加载。

## 数据目录

默认 `$DSH_HOME/psyche`，未取得 `DSH_HOME` 时回退 `~/.dsh/psyche`。目录根部必须有：

```json
{
  "product": "dsh-psyche",
  "formatVersion": 1
}
```

空目录首次启动时自动写入。旧 Lingban 数据目录、无标识的已有数据库、损坏或版本不符的标识会被拒绝，不会被 Psyche 自动接管。该标识只防误操作，不是 Owner 身份凭据。

数据库文件名保持 `memory.sqlite3`；备份格式为 `psyche-archive`。旧 `lingban-archive` 不自动接受。

## 兼容边界

- 不注册 `ctx.lingban`、旧工具、旧 API、旧环境变量、旧数据目录或旧备份格式。
- 捕获层只读识别旧 `source.lingban` 注入标记，用于排除历史会话中的注入块；它不能作为 Psyche 注入证明。
- 不修改 DeepSeek Harness、Host Section/事件/Slot、Schema 版本或既有权限边界。

## 开发

```powershell
pnpm run workspace:typecheck
pnpm run build
pnpm run test:all
```

详细设计、迁移基线与验收状态见 `dsh-psyche-DEV.md`；工程约束见 `AGENTS.md`。

## 许可

MIT。第三方组件许可见 `THIRD_PARTY_NOTICES.md`。
