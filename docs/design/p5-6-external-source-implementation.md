# P5-6 外界来源登记与隔离（实施记录）

- 状态：已实现（2026-11-15），模块级验收；Host 未验证
- 关联：`p5-external-source-contract.md`、`p5-growth-reflection-contract.md`
- 边界：**不主动联网、不做采集器、不自动修改人格**；本阶段只提供登记、隔离、清理与审计接口。

## 1. 范围

| 项 | 决定 |
|---|---|
| 来源类型 | `web` / `file` / `group` |
| 正文 | 不复制；`source_id` 必须指向已有 Core `sources` 行 |
| 内容哈希 | 调用方传入原始文本，模块用 UTF-8 计算 SHA-256 |
| 登记 | 不可变；重复登记只校验身份/内容/Scope，不合并 |
| 删除/过期 | append-only `external_source_deletion_events`，当前态按最新 `event_id` |
| 风险检测 | best-effort 提示，不作为准入依据 |
| Prompt | 不进入 persona/growth；后续若展示只能作为带来源标记的引用数据 |

## 2. Schema v28

```sql
CREATE TABLE external_sources (
  source_id       TEXT PRIMARY KEY REFERENCES sources(source_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('web','file','group')),
  provenance      TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  risk_flags      TEXT NOT NULL DEFAULT '[]',
  scope           TEXT NOT NULL CHECK (scope IN ('personal','contact','room')),
  scope_ref       TEXT,
  disclosure      TEXT NOT NULL,
  retention_until INTEGER,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  CHECK ((scope = 'room' AND scope_ref IS NOT NULL) OR (scope <> 'room'))
);

CREATE TABLE external_source_deletion_events (
  event_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES external_sources(source_id) ON DELETE CASCADE,
  action    TEXT NOT NULL CHECK (action IN ('delete','purge')),
  at        INTEGER NOT NULL,
  by        TEXT NOT NULL,
  reason    TEXT
);
```

`SCHEMA_VERSION = 28`，业务表 66 张，迁移 v2→v28 共 27 步。

## 3. 模块

`packages/core/src/external-source.ts` 导出：

- `detectExternalInstructionRisk(text)` → 命中原因（`role_override` / `system_prompt_probe` / `tool_call_request` / `secret_request`）；
- `sha256OfExternalContent(content)`；
- `recordExternalSource(db, input)` → `{row, created}`；要求 `createdBy` 为 `os:<SID/UID>`、`provenance`/`disclosure` 非空；
- `listExternalSources(db, {kind?, includeDeleted?})`；
- `andExternalSourceActive(alias)`：统一过滤谓词，删除事件生效后不再返回；
- `requestExternalSourceDeletion(db, {sourceId, action, by, reason})`：幂等；`purge` 后不可再 `delete`；
- `purgeExpiredExternalSources(db, {by, now})`：只处理 `retention_until <= now` 且无删除事件的登记。

### Scope 规则

- `group` 来源必须 `scope='room'` 且 `scope_ref` 等于 `sources.room_id`；否则 `E_SCOPE_UNDECIDABLE` / `E_SCOPE_CONFLICT`。
- `contact` 必须给 `scope_ref`；若 Source 有 `sender_contact_id`，必须一致。
- `personal` 不允许 `scope_ref`。
- 缺失或冲突失败关闭，不默认 `global`。

### 删除语义（重要限制）

`sources` 表是 append-only（UPDATE 触发器拒绝），因此本模块只能做**逻辑删除**：

- 追加删除事件后，`listExternalSources` / `andExternalSourceActive` 不再返回该来源；
- `sources.text` 原文仍在库内，本模块**不宣称物理擦除**；
- 物理擦除需要独立的库重建 / 冷备份流程，属于后续运维项。

## 4. CLI

`tools/psyche-source.mjs`：

```text
list   --data-dir <dir> [--kind …] [--include-deleted]
record --data-dir <dir> --source <src_…> --kind … --provenance … --scope … [--ref …] --disclosure … [--content-file …] [--retention-days N] --owner <SID/UID> [--yes]
delete --data-dir <dir> --source <src_…> --owner <SID/UID> [--reason …] [--yes]
purge  --data-dir <dir> --owner <SID/UID> [--yes]
```

Owner 由操作系统身份解析（Windows `whoami /user` 的 SID，POSIX `process.getuid()`），与 `--owner` 比对；未给 `--yes` 只预览。

## 5. 测试

`test/external-source.ts`：34 断言，覆盖

- 风险模式与哈希；
- 登记幂等、同哈希不同来源不合并、篡改不可变；
- group/contact/personal Scope 拒绝与接受；
- 风险标记落库；
- 删除事件、默认列表过滤、`andExternalSourceActive`；
- 过期清理与幂等、purge 后拒绝 delete。

## 6. 边界与未完成

- Host 级未验证：没有真实宿主调用链；CLI 未在真实库演练（NOT VERIFIED）。
- 未实现网页抓取、文件监听、群采集；这些属于后续阶段。
- 物理擦除、冷备份保留期、删除请求审计展示未实现，报告单独记 PARTIAL。
- 风险检测是启发式规则，不是安全边界；所有外部内容仍需 Scope/Disclosure 与 Owner 确认。
