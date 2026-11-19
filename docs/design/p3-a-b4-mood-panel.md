# P3-A B4 只读情绪面板（设计冻结）

版本：v1 / 2026-11-12
状态：B4-0 冻结（B4-1 接口、B4-2 前端按本稿实施）
上游：`p3-a-mood-state-machine.md`（B0）、`p3-a-b2-turn-judgment.md`（B2）、`p3-a-b3-tone-projection.md`（B3）

## 0. 目标与不做什么

面板把**已经存在**的 Mood 数据展示出来：当前 33 维有效值、当前语气投影、真实写入历史。

不做：

- 不新增表、不新增写入、不提供编辑入口（无 POST/PUT/DELETE）。
- 不接管 B1/B2/B3 的语义：不重算衰减公式、不重新实现投影、不改阈值/白名单。
- 不接 Contact Affect / Affinity / Trust，不画关系数据。
- 不把离散写入快照伪装成连续情绪监控曲线。

## 1. 两类数据必须分开

| 数据 | 来源 | 语义 |
| --- | --- | --- |
| 当前值 | `loadMood(db)`（逐维按 `updated_at` 衰减） | 此刻的**有效值**，用于当前语气与 33 维列表 |
| 历史值 | `global_mood_history` | 写入当时的**原始快照**，不衰减、不回填 |

历史曲线只画后者；当前值不写回历史。每个 `op_id` 的一次写入固定产生 33 行，必须按 `op_id`（并以 `at` 校验）分组还原成一次快照，禁止把 33 行当成 33 个时间点。

## 2. 服务端接口

```text
GET /api/psyche/mood?limit=<n>
```

- 只允许 `GET`；其他方法 `405`。
- `limit` 默认 30，夹到 `[1, 120]`，表示**快照次数**（不是行数）。
- 数据未就绪：`503 { ok:false, error:'数据库还没准备好' }`，不伪造中性数据。
- 查询失败：`500 { ok:false, error }`。
- 响应 `Cache-Control: no-store`。

响应体（只读、JSON 安全）：

```jsonc
{
  "ok": true,
  "personaId": "main",
  "stateVersion": 6,
  "updatedAt": "2026-11-12T01:00:00.000Z",
  "configVersion": 1,
  "tone": { "tone": "平稳", "secondary": null, "neutral": true, "projectionVersion": 1 },
  "groups": {
    "basic":        [{ "key": "calm", "label": "平静", "value": 42.99, "baseline": 45, "halfLifeHours": 6 }],
    "compound":     [],
    "contemporary": []
  },
  "history": [
    { "at": "2026-11-11T23:15:00.000Z", "values": { "calm": 42.6, "happy": 34.6 } }
  ],
  "historyLimit": 30,
  "historyTotal": 5
}
```

- `values` 是**原始持久化值**（0–100，不做衰减、不做投影）。
- 历史按时间升序返回（旧 → 新），最多 `limit` 个完整快照。
- 不完整的组（行数不足 33）丢弃，不拼接。
- `op_id`、`reason` 只留在服务端查询与审计，不进响应；面板不显示内部标识或规则细节。
- 响应不返回 33 维之外的任何一个数；`tone` 只含词的投影，不含 strength。

## 3. 面板三区

1. **当前情绪**：`tone.tone` 大字 + `secondary`（有则「略带 X」）+ 「实时投影」说明；`neutral` 时不显示辅助。
2. **当前状态**：33 维按 `basic 11 / compound 18 / contemporary 4` 分组，显示 `label` 与一位小数的 `value`；不在前端做任何判断，只读字段。
3. **历史趋势**：默认选 `happy`，下拉切换到任一维度；曲线使用真实快照的 `at`（UTC → 客户端本地时间）与该维原始值；无历史显示空状态，不补 7 天、不插值。

替换现状：状态页「情绪趋势」卡片当前是 `chartMoodOption()` 的硬编码 7 天假数据与 `CHART_PLACEHOLDER_NOTE`，B4-2 删除该假数据与提示，改为真实数据；雷达 / 亲密环 / 关系网络仍属 P3-B，保留占位说明。

## 4. 失败与空态

| 情况 | 面板 |
| --- | --- |
| 接口 503 / 500 | 情绪卡片显示「暂时读不到情绪状态」，不显示假数字 |
| 历史为空 | 「还没有情绪写入记录」，不画曲线 |
| 某维从未写入 | 该维不出现在历史里；曲线按实际快照点绘制 |
| 快照不足 33 行 | 丢弃该快照（服务端） |

## 5. 只读证明

- 路由只执行 `SELECT`；`loadMood` 本身只读（B1 已测）。
- 测试断言：调用前后 `global_mood_state` / `global_mood_history` / `mood_meta` 行数与 `state_version` 不变。
- 前端无写动作，只有 `GET`。

## 6. 测试矩阵

| 组 | 断言 |
| --- | --- |
| 投影与分组 | 33 维齐全、三组计数 11/18/4、当前值与 `loadMood` 一致 |
| 历史分组 | 一次写入 33 行 → 1 个快照；两次写入 → 2 个；乱序按升序返回 |
| 窗口 | `limit` 默认 30、夹到 1..120、`historyTotal` 为总快照数 |
| 只读 | 调用前后三张表行数与 `state_version` 不变 |
| 空库/无写入 | 空历史、中性语气、不报错 |
| 不完整快照 | 33 行不全的快照被丢弃 |
| 响应裁剪 | 不含 `op_id`/`reason`/strength/数值之外字段 |
| 方法 | 非 GET → 405 |

## 7. 版本与文档

- 面板不改 schema（仍 v19 / 46 表），不改 B1/B2/B3 代码语义。
- 实施后在 `docs/audit/p3-a-b4-mood-panel.md` 记录接口形状、测试数字、边界。
- DEV 版本 v27.63；README 测试清单加本套件。
