// 心灵记忆库结构：三十一张表 + FTS5 辅助索引（设计 §11.2 / §11.7）。
// 迁移只按 PRAGMA user_version 判定，两种驱动共用同一套 migration（§11.6）。
// 每张表/每个索引的注释标了它对应设计文档里的哪一段，方便对照复核。
//
// 职责：只声明「库长什么样」——建表 / 索引 / 只追加触发器 / v2 结构升级。
// 这个文件不含任何读写业务数据的代码，也不 import 驱动，能被任意运行时安全引用。
//
// 关键约束：
// - 全部 SQL 都是字符串常量，由 adapter.ts 的 migrate() 用 exec() 整段执行；
// - 迁移只能往前走：按 MIGRATIONS 的顺序跑，已应用的按 version 跳过；
//   历史迁移不许回头改（已建过库的机器不会重跑它，改了也到不了那边）；
//   要改结构只能新加一条 Migration，v2 就是这么来的；
// - 「只追加」这类铁律靠触发器在库层兜底，不指望每个调用方都自觉；
// - 迁移内部不用外键级联做危险动作，DROP/ALTER 都成对写好，避免留下半套结构。
//
// 被谁调用：adapter.ts 的 migrate() 读 MIGRATIONS / SCHEMA_VERSION；
// 测试与诊断脚本读 EXPECTED_TABLE_COUNT 做表数量自检。

/** 当前插件支持的最高 schema 版本；与最后一条 MIGRATIONS 的 version 必须同步。 */
export const SCHEMA_VERSION = 31

/**
 * v1 建库脚本：33 张表里属于 P1 的 31 张 + 索引 + 只追加触发器 + FTS5 空壳。
 *
 * 整段由 migrate() 在一个事务里 exec() 一次，所以这里不写 BEGIN/COMMIT。
 * 顺序有意义：被引用的表（persona_config / contacts / rooms / sources / events）
 * 必须先于引用它们的表出现，否则外键检查在建表时就可能报错。
 */
const P1_INITIAL = `
-- ── 身份与配置（5）────────────────────────────────────────────

-- §11.2 身份配置 / §11.10 迁移记录
-- 已应用迁移的账本，version 与 PRAGMA user_version 是同一个数，必须一致。
-- 用 version 做主键而不是自增行号：让「重放」天然幂等 —— 同一版号插第二次必然撞
-- 主键，读侧不用再加一层去重判断。
-- adapter.migrate() 在同一条 SQL 事务里先 exec(sql) 再写这行，
-- 所以「结构变了但没记账」「记了账但结构没变」两种半成品都不可能留下。
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 单一人格：personaId 固定 main（§0.3）
-- 为什么只留一行：插件只服务一个人格，多行会让「谁是主」变成需要解释的状态，
-- 而所有业务表都 REFERENCES 这一列，等于给整库钉了一个统一的人格作用域。
-- persona_json 存可热更的人格参数（语气/习惯/阶段配置），identity_path 指向磁盘上的
-- identity.md：内容在库里、文件在磁盘上，人改文件不需要写库，也不会把长文塞进 SQLite。
CREATE TABLE persona_config (
  persona_id    TEXT PRIMARY KEY,
  type          TEXT NOT NULL DEFAULT 'preset',
  identity_path TEXT,
  persona_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- §4.1 Contact 身份：主键是 platform + stable_user_id，展示名不进键
-- display_name 会改（改昵称、改群名片），拿它当键会在改名那天断掉全部历史；
-- 真正的键是「平台 + 稳定用户号」，展示名只是当前的显示快照，允许过期。
-- contact_id 是内部主键并被大量表引用：它稳定，人换了平台绑定也不动它，
-- 所以结论、关系、情绪这些行不会因为身份合并而失配。
-- UNIQUE (platform, stable_user_id) 保证同一个人在同一个平台上只有一条主记录。
CREATE TABLE contacts (
  contact_id     TEXT PRIMARY KEY,
  persona_id     TEXT NOT NULL REFERENCES persona_config(persona_id),
  platform       TEXT NOT NULL,
  stable_user_id TEXT NOT NULL,
  display_name   TEXT,
  relation_label TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (platform, stable_user_id)
);

-- 一个 Contact 可以在多个平台/账号上出现；合并必须由人确认（§4.1）
-- 这张表记的是「候选身份」：同一个 stable_user_id 在另一个平台出现时先落一行，
-- 但 merged_by_user = 0 表示这只是观察到的关联，不是人真的认了这次合并。
-- 模型不许自己把两个号判成同一个人 —— 判错的代价是别人的隐私张冠李戴。
-- ON DELETE CASCADE：主体删掉时这些候选行跟着消失，不留指向空 contact 的孤儿。
CREATE TABLE contact_identifiers (
  identifier_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id     TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,
  stable_user_id TEXT NOT NULL,
  handle         TEXT,
  merged_by_user INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE (platform, stable_user_id)
);

-- 群 / 私聊 / 桌面会话都收敛到 rooms
-- 统一成一张表，是为了让 sources.room_id 这一个外键在四种通道上都指得动，
-- 不必为「群消息」「私聊」各建一套同构结构，也就不必写两套查询。
-- 两个 CHECK 把 channel 与 capture_mode 的取值钉死在设计文档的枚举里：
-- capture_mode 决定桥接把多少消息当素材（mentioned_only 最省、all_visible_messages 最全），
-- 写错值不会报错、只会让采集策略静默失效，所以必须在库层拦。
-- active 是软下线标记：房间停用后历史仍要能查，不能靠删行。
CREATE TABLE rooms (
  room_id          TEXT PRIMARY KEY,
  persona_id       TEXT NOT NULL REFERENCES persona_config(persona_id),
  platform         TEXT NOT NULL,
  channel          TEXT NOT NULL,
  external_room_id TEXT,
  title            TEXT,
  capture_mode     TEXT NOT NULL DEFAULT 'replied_or_mentioned',
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (channel IN ('private', 'group', 'desktop', 'web', 'system')),
  CHECK (capture_mode IN ('mentioned_only', 'replied_or_mentioned', 'all_visible_messages'))
);

-- §4.1 群成员：只记「谁在哪个群出现过」，不作为身份合并依据
-- 「同群」只是极弱的证据：两个人待在同一个群里不代表是同一个人，
-- 所以这张表不参与身份判定，只用来回答「这段语境里谁在场」。
-- 复合主键天然去重，写侧用 UPSERT 只更新 last_seen_at，不产生重复行。
CREATE TABLE room_members (
  room_id       TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  contact_id    TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (room_id, contact_id)
);

-- ── 会话（2）────────────────────────────────────────────────

-- §11.3 会话活动窗口：independenceKey 的物理载体（连续 N 分钟算一组）
-- 「独立证据」的判定需要「同一段连续对话只算一个来源」，窗口键就是这个载体：
-- 同一窗口内的多条消息共用一个 activity_window_key，去重时按它折叠成一条证据。
-- source_count 是写侧累计的计数，不是派生列 —— 读的时候不必再扫一遍 sources。
CREATE TABLE session_activity_windows (
  window_key   TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL REFERENCES persona_config(persona_id),
  session_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0
);

-- §5.1 Source：原始消息 / 图片 / 语音 / 网页 / 操作结果，只增不改
-- 只增不改是硬约束：UPDATE 被文件末尾的触发器拦住，所以这张表天然是审计底稿。
-- mentions / quoted_source_refs / metadata 用 JSON 文本存：SQLite 没有数组类型，
-- 而这几列只做整体读写、不参与等值查询，为它们拆子表带来的连接成本不值得。
-- 原始素材一律不改写：脱敏靠「不引用」而不是「改原文」，改过的原文就不再是证据。
-- CHECK (origin) 区分 self / external / user：派生结论时必须能排除自述来源，
-- 否则「自己说的话」会被当成外部证据，独立性与可信度都会崩。
CREATE TABLE sources (
  source_id           TEXT PRIMARY KEY,
  persona_id          TEXT NOT NULL REFERENCES persona_config(persona_id),
  platform            TEXT NOT NULL,
  channel             TEXT NOT NULL,
  room_id             TEXT REFERENCES rooms(room_id),
  session_ref         TEXT,
  sender_contact_id   TEXT REFERENCES contacts(contact_id),
  message_id          TEXT,
  reply_to_message_id TEXT,
  mentions            TEXT NOT NULL DEFAULT '[]',
  quoted_source_refs  TEXT NOT NULL DEFAULT '[]',
  origin              TEXT NOT NULL,
  kind                TEXT NOT NULL,
  text                TEXT,
  asset_sha256        TEXT,
  activity_window_key TEXT REFERENCES session_activity_windows(window_key),
  metadata            TEXT NOT NULL DEFAULT '{}',
  captured_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CHECK (origin IN ('user', 'external', 'self')),
  CHECK (channel IN ('private', 'group', 'desktop', 'web', 'system'))
);

-- ── 事件（4）────────────────────────────────────────────────

-- §5.2 Event 十一类；只追加，永不编辑
-- kind / type 用一段两段式 CHECK 联合判断：interaction 有一组合法 type，cognitive 另有
-- 一组，写错组合（例如 cognitive 配 conversation）在 INSERT 当场就失败，
-- 而不是等到几周后派生层读出一条谁都不认识的事件。
-- 除了 text / subject_refs / caused_by 这些「发生时就定死」的字段，没有「当前状态」列：
-- 状态属于 artifacts 与 projection，事件只是「发生过」的记录，不随时间改变。
-- op_id 冗余在这里是为了按幂等键找回整批写入（失败重放时对账用）。
CREATE TABLE events (
  event_id       TEXT PRIMARY KEY,
  persona_id     TEXT NOT NULL REFERENCES persona_config(persona_id),
  kind           TEXT NOT NULL,
  type           TEXT NOT NULL,
  at             TEXT NOT NULL,
  session_id     TEXT,
  room_id        TEXT REFERENCES rooms(room_id),
  subject_refs   TEXT NOT NULL DEFAULT '[]',
  text           TEXT NOT NULL,
  caused_by      TEXT,
  relation_to    TEXT,
  confidence     TEXT NOT NULL DEFAULT 'medium',
  op_id          TEXT,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  created_at     TEXT NOT NULL,
  CHECK (kind IN ('interaction', 'cognitive')),
  CHECK (confidence IN ('low', 'medium', 'high')),
  CHECK ((kind = 'interaction' AND type IN
            ('conversation', 'agreement', 'commitment', 'conflict', 'correction', 'refusal', 'action_result'))
      OR (kind = 'cognitive' AND type IN
            ('contradiction_detected', 'stance_revised', 'review_result', 'fact_learned')))
);

-- §11.3 sourceRefs 走关联表（Source ↔ Event 是 M:N）
-- 一条事件常由多条来源支撑（同一句话在私聊和群里都出现），一条来源也能触发多条事件，
-- 所以是 M:N。用关联表而不是在 events 里存 JSON 数组，是为了能反查
-- 「这条来源被哪些事件用过」（idx_event_sources_source 就是为这个建的）。
-- 两侧都 ON DELETE CASCADE：任一端消失，这条关系也就没有意义了。
CREATE TABLE event_sources (
  event_id  TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, source_id)
);

-- §5.2 causedBy / resultedIn 的显式因果边；不能靠时间推断
-- 「A 在 B 之前发生」不等于「A 导致 B」，所以因果必须是写进来的边，
-- 读的时候也不许用 at 排序去猜因果关系。
-- relation 被 CHECK 收窄成三种，避免 respondsTo / responds_to / response 这类同义写法
-- 把同一件事记成三种边。
-- 注意 target_event_id 没有级联删除：一条事件被删时，指向它的事件本来就是异常数据，
-- 交给外键直接报错暴露出来，比默默连坐删除更好。
CREATE TABLE event_relations (
  event_id        TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  target_event_id TEXT NOT NULL REFERENCES events(event_id),
  relation        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, target_event_id, relation),
  CHECK (relation IN ('respondsTo', 'relatedTo', 'resultedIn'))
);

-- ── 认知（8）────────────────────────────────────────────────

-- §5.3 Artifact 聚合根：只有身份信息，结论在 revisions 上
-- 聚合根故意不存结论正文：正文、置信度、状态都是「某一版」的属性，
-- 放在这里会让「改一次表述」变成改写对象本身，历史就没地方放了。
-- kind 一旦定下不跟着版本变化（一条信念不会变成关系），所以放聚合根；
-- 需要变 kind 就新建对象并写 artifact_lineage 的 splitFrom 边。
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES persona_config(persona_id),
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  op_id       TEXT,
  CHECK (kind IN ('fact', 'belief', 'impression', 'stance', 'relationship', 'procedure'))
);

-- §11.3 一行一条 Revision；不建 artifact_heads，读取同 id 取 max(revision)，不先过滤 state
-- 为什么不留 heads 表：heads 与 revisions 迟早会不一致，而「当前版本」本来就能由
-- max(revision) 算出来；派生值单独存一份，只会多出一处需要维护的真值。
-- 尤其注意「先过滤 state 再取 max」是错的：最新版本可能正是 challenged / superseded，
-- 那也要读出来（读侧看到的是「事实已存疑」，而不是退回上一个自信的旧版本）。
-- state 的 CHECK 里既有人格过程态（draft / testing / deprecated），也有结论态
-- （active / challenged / superseded / retracted / forgotten）：同一条历史行可能处于任意一种，
-- 推进版本时写新行，绝不 UPDATE 旧行 —— 触发器 trg_artifact_revisions_no_update 会拦。
-- basis_count / independent_evidence_count / salience 是派生输入，写入时算好，
-- 读侧不重新聚合（每次读都 join 一遍 evidence 太贵）。
CREATE TABLE artifact_revisions (
  artifact_id                TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  revision                   INTEGER NOT NULL,
  state                      TEXT NOT NULL,
  statement                  TEXT NOT NULL,
  subject_refs               TEXT NOT NULL DEFAULT '[]',
  payload                    TEXT NOT NULL DEFAULT '{}',
  confidence                 TEXT NOT NULL DEFAULT 'medium',
  basis_count                INTEGER NOT NULL DEFAULT 0,
  independent_evidence_count INTEGER NOT NULL DEFAULT 0,
  salience                   REAL NOT NULL DEFAULT 0,
  temporal                   TEXT NOT NULL DEFAULT '{}',
  direct_extraction          INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  op_id                      TEXT,
  schema_version             TEXT NOT NULL DEFAULT '1.0',
  PRIMARY KEY (artifact_id, revision),
  CHECK (state IN ('active', 'challenged', 'superseded', 'retracted', 'forgotten', 'draft', 'testing', 'deprecated')),
  CHECK (confidence IN ('low', 'medium', 'high'))
);

-- §5.4 Evidence：绑定到版本，不绑定到对象
-- 证据跟着它支撑的那一版走：人改口之后，旧证据仍然指向旧表述，
-- 所以外键是 (artifact_id, revision) 复合键，而不是只挂 artifact_id。
-- independence_key 是「别拿同一句话证明两次」的物理落地：同一键出现多次只算一条独立证据；
-- 它由写侧从 source 的 independence_key / activity_window_key 推出来，不由模型自填。
-- relation 的 CHECK 把「反对」与「限定」都留出来了：contradicts 让反思有东西可撞，
-- qualifies 让「大体对但有个例外」不必被塞进 supports。
CREATE TABLE artifact_evidence (
  artifact_id      TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  source_id        TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  relation         TEXT NOT NULL,
  quote            TEXT,
  confidence       TEXT NOT NULL DEFAULT 'medium',
  independence_key TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision, source_id, relation),
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_revisions(artifact_id, revision) ON DELETE CASCADE,
  CHECK (relation IN ('supports', 'contradicts', 'qualifies', 'contextualizes'))
);

-- 这条结论是哪几个事件触发出来的（Event → Artifact 的反向索引底座）
-- 存下来是为了能回答「凭什么有了这个想法」：复核一条结论时顺着这里找回原始事件，
-- 再顺 event_sources 找回原始来源，整条推导链不断。
-- 复合主键带 revision：同一个对象的不同版本可以源自不同事件，不能折叠成一行。
CREATE TABLE artifact_trigger_events (
  artifact_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  event_id    TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, revision, event_id),
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_revisions(artifact_id, revision) ON DELETE CASCADE
);

-- derivedFrom 血统
-- from_revision 可空：允许只记得「从那个对象推出来」而不钉死到某一版，
-- splitFrom 产生的子结论尤其没有单一父版本。
-- lineage_id 用自增而不是复合主键：同一对父子可以有多条关系记录（不同时间各推导一次），
-- 它们是不同的历史事实，不该被主键去重掉。
CREATE TABLE artifact_lineage (
  lineage_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id      TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  from_artifact_id TEXT NOT NULL,
  from_revision    INTEGER,
  relation         TEXT NOT NULL DEFAULT 'derivedFrom',
  created_at       TEXT NOT NULL,
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_revisions(artifact_id, revision) ON DELETE CASCADE,
  CHECK (relation IN ('derivedFrom', 'revisedFrom', 'splitFrom'))
);

-- §5.3 relations：supersedes / contradicts / tensionWith / relatedTo
-- 与 artifact_lineage 的分工：lineage 记「从哪儿推出来的」（发生学，指过去），
-- 这里记「现在和谁冲突、取代了谁」（语义关系，指当下）。
-- supersedes 让改口可追溯（旧结论不被删，只是被指为已被取代）；
-- contradicts / tensionWith 让反思有具体对象可撞，而不是一句「我可能记错了」。
-- target_revision 可空：指向对象整体时不钉死到某一版。
CREATE TABLE artifact_relations (
  artifact_id        TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  target_artifact_id TEXT NOT NULL,
  target_revision    INTEGER,
  relation           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision, target_artifact_id, relation),
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_revisions(artifact_id, revision) ON DELETE CASCADE,
  CHECK (relation IN ('supersedes', 'contradicts', 'tensionWith', 'relatedTo'))
);

-- §10.1 注入第 2 段「当前自我」，派生投影，可重算
-- 它是投影而不是事实源：self_view 随时可以被重算覆盖，所以这里不需要历史，
-- 真正的历史在 personality_history（人工改动）与 events（发生过什么）。
-- revision 让读侧能判断「这份投影是不是旧的」；v2 迁移又给它加了
-- growth_input_version 列，用途见本文件 V2_GROWTH 第 5 段的注释。
CREATE TABLE persona_state (
  persona_id TEXT PRIMARY KEY REFERENCES persona_config(persona_id),
  self_view  TEXT NOT NULL DEFAULT '',
  revision   INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  op_id      TEXT
);

-- 人格参数的改动流水：谁在什么时候把哪个字段从什么改成了什么
-- 只记人工 / 提案落地的改动，不记每次派生重算 —— 派生结果可以重算，不算「改动」，
-- 混进来会让审计流水被千万条噪声淹没。
-- op_id 把这次改动挂回触发它的那次操作，方便复核与幂等重放。
-- before_value / after_value 都存原值（可空）：只记「改了什么字段」无法还原现场。
CREATE TABLE personality_history (
  history_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id   TEXT NOT NULL REFERENCES persona_config(persona_id),
  field        TEXT NOT NULL,
  before_value TEXT,
  after_value  TEXT,
  reason       TEXT,
  at           TEXT NOT NULL,
  op_id        TEXT
);

-- ── 成长（2）────────────────────────────────────────────────

-- §8.2 四阶段：trust / autonomy / initiative / integration（单调推进，不回退）
-- 单行状态：persona_id 做主键，等于「整库只有一个当前阶段」，不会出现两个并存的阶段。
-- 单调性由写侧保证（growth.ts 只往前进，且每次都从旧值出发判断），
-- 这里的 CHECK 只拦非法枚举 —— SQLite 的 CHECK 没法表达「必须 >= 旧值」这种跨行不变量，
-- 所以只能在代码 + 事务里兜，不要误以为库层管住了单调。
-- stalled_at 是「卡住」的起点，纯诊断信息，不参与晋级判定。
CREATE TABLE phase_state (
  persona_id TEXT PRIMARY KEY REFERENCES persona_config(persona_id),
  phase      TEXT NOT NULL DEFAULT 'trust',
  since      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stalled_at TEXT,
  op_id      TEXT,
  CHECK (phase IN ('trust', 'autonomy', 'initiative', 'integration'))
);

-- 阶段晋级的依据行：一行 = 一条证据（不是「一次晋级」）
-- 同一 milestone_id 下的一整组行才是「这次晋级的完整依据」，
-- 所以「一次晋级」在库里是 1 个 milestone + N 条 evidence，而不是一个 JSON 数组：
-- 这样能按证据类型、按独立键统计，也能单独对某一条打脱敏标记。
-- v1 只有 note + event_id；v2 用 ADD COLUMN 补了 milestone_id / gate /
-- independence_key 等列 —— SQLite 不能 ALTER CHECK，但 ADD COLUMN 可以，所以这里靠加列升级。
-- 删证据只打 redacted_at 标记，不 DELETE：阶段是单调的，删行也不能让阶段回退。
CREATE TABLE phase_evidence (
  evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL REFERENCES persona_config(persona_id),
  phase       TEXT NOT NULL,
  event_id    TEXT REFERENCES events(event_id),
  artifact_id TEXT,
  note        TEXT,
  at          TEXT NOT NULL
);

-- ── 心情（4）────────────────────────────────────────────────

-- 全局心情投影：按 (persona, dimension) 一行存当前值
-- 投影表可以整表重算，所以没有 history 表那么重要；history 才是不可变流水。
-- value 用 REAL 且默认 0：量纲（-1..1 还是 0..100）归心情层定义，库只负责存数，
-- 免得规则一调就要做数据迁移。
-- 不存 updated_at 之外的时间语义：情绪衰减是在读侧按 updated_at 现算的。
CREATE TABLE global_mood_state (
  persona_id TEXT NOT NULL REFERENCES persona_config(persona_id),
  dimension  TEXT NOT NULL,
  value      REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (persona_id, dimension)
);

-- 全局心情的变化流水：一行一次变化，只追加
-- 和关系账本同一个理由：投影一旦算错或规则调参，要能从流水完整重算回来，
-- 而不是只能接受一个来路不明的数字。
-- reason 记「为什么变」（一条事件 id / 一句说明），出问题时能对着原因复核。
CREATE TABLE global_mood_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL REFERENCES persona_config(persona_id),
  dimension  TEXT NOT NULL,
  value      REAL NOT NULL,
  reason     TEXT,
  at         TEXT NOT NULL,
  op_id      TEXT
);

-- 针对某个人的情绪投影：与 global_mood_state 同构，只是多一个 contact_id 维度
-- 主键是 (persona, contact, dimension)：同一个维度在不同人身上互不影响，
-- 读某个人时只取自己那一组，不会被别人的值污染。
-- ON DELETE CASCADE：人从库里删掉时，针对他的投影一起消失，不留孤儿行。
CREATE TABLE contact_affect_state (
  persona_id TEXT NOT NULL REFERENCES persona_config(persona_id),
  contact_id TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  dimension  TEXT NOT NULL,
  value      REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (persona_id, contact_id, dimension)
);

-- 针对某个人的情绪变化流水：只追加，用来重算 contact_affect_state
-- 不带 reason 列（与 global_mood_history 不同）：这里的「为什么」几乎总能从
-- 同一次操作的事件/来源反查，再存一遍只是冗余；global 心情则常常来源不明。
CREATE TABLE contact_affect_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL REFERENCES persona_config(persona_id),
  contact_id TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  dimension  TEXT NOT NULL,
  value      REAL NOT NULL,
  at         TEXT NOT NULL,
  op_id      TEXT
);

-- ── 关系（2）────────────────────────────────────────────────

-- §11.3 账本，只追加；好感可从账本完整重算
-- 每行同时记「原始分 base_delta」和「实际生效分 applied_delta」两份：
-- 规则调参之后能拿原始分重算，不必重放全部历史；applied_delta 则忠实记下当时的折扣结果，
-- 事后看「为什么当年只涨了 0.5」有据可查。
-- rule_version 让不同算法版本算出的分不混在一起比较；
-- independence_key 让「同一件事不重复计分」在库层可验证（同一事件重复触发时先查这个键）。
-- signal_type + polarity 拆开存：类型（礼物 / 回应 / 冲突）是语义，极性是方向，
-- 合成一列会让「同一个类型这次是正还是负」表达不出来。
CREATE TABLE relationship_signals (
  signal_id        TEXT PRIMARY KEY,
  persona_id       TEXT NOT NULL REFERENCES persona_config(persona_id),
  contact_id       TEXT NOT NULL REFERENCES contacts(contact_id),
  source_id        TEXT REFERENCES sources(source_id),
  event_id         TEXT REFERENCES events(event_id),
  independence_key TEXT NOT NULL,
  signal_type      TEXT NOT NULL,
  polarity         TEXT NOT NULL,
  base_delta       REAL NOT NULL,
  confidence       TEXT NOT NULL,
  applied_delta    REAL NOT NULL,
  rule_version     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  op_id            TEXT,
  CHECK (polarity IN ('positive', 'negative', 'neutral')),
  CHECK (confidence IN ('low', 'medium', 'high'))
);

-- §6.2 好感投影：七档，0–100，默认 50；trust 不在这里重复存（读 relationship Artifact 的 head）
-- 投影表只放「能由账本重算出来的东西」；信任是有版本的结论（artifact_revisions），
-- 在这里再存一份必然和结论层打架，所以宁可不存。
-- band 是 affinity 的离散化结果，落库是为了读侧能直接按档位筛，不必到处重复写边界判断；
-- 它必须与 affinity 一起更新，否则会出现「数值 82、档位 friendly」这种自相矛盾的行。
-- manual_override = 1 表示这一格被人手动定过：重算时必须跳过，
-- 没有这个标记，人的调整会在下一次重算时被静默抹掉。
CREATE TABLE relationship_affinity_state (
  persona_id      TEXT NOT NULL REFERENCES persona_config(persona_id),
  contact_id      TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  affinity        REAL NOT NULL,
  band            TEXT NOT NULL,
  manual_override INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (persona_id, contact_id),
  CHECK (band IN ('very_close', 'high', 'friendly', 'neutral', 'cautious', 'distant', 'hostile'))
);

-- ── 事务与提案（3）──────────────────────────────────────────

-- §11.4 opId 幂等：同 opId 重复调用不再写第二次
-- 主键就是 op_id：重复请求在 INSERT 处撞键，幂等是结构保证的，不需要「先查后写」
-- （先查后写有并发窗口，两个请求可能都查到「没有」）。
-- args_hash 让人能区分「同一个 opId 换了参数」这种冲突（E_IDEMPOTENT_CONFLICT）：
-- 同键不同参是客户端 bug，不能当重放静默放过。
-- status / result / error / duration_ms 让这张表自身就是执行记录：
-- 失败也要留一行，否则「为什么没做成」只剩日志。
-- 注意 trg_operations_no_update 只冻结 status = 'ok' 的行，失败行允许补结局（见触发器段）。
CREATE TABLE operations (
  op_id       TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args_hash   TEXT NOT NULL,
  status      TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  duration_ms REAL NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'tool',
  created_at  TEXT NOT NULL,
  finished_at TEXT,
  CHECK (status IN ('ok', 'failed'))
);

-- §9.1 / §12.1 提案：生活参数可提，关系参数只有用户能改，安全参数连提案都拒绝
-- CHECK (partition) 在 v1 只有 life / relationship / safety；v2 重建表加了 growth
-- （SQLite 改不了 CHECK，所以 v2 只能整表重建再搬数据，见 V2_GROWTH 第 1 段）。
-- partition 分区本身就是权限边界：能不能提、谁能批都由它决定，
-- 所以值必须先由应用层判过，再由 CHECK 兜一次（写错分区的提案比没提更危险）。
-- status 只有 pending / accepted / rejected 三态：提案不删，批过的也留着可查；
-- 一起记 decided_at / decided_by，让「谁批的」永远有答案。
CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES persona_config(persona_id),
  partition   TEXT NOT NULL,
  target      TEXT NOT NULL,
  change      TEXT NOT NULL,
  rationale   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  decided_by  TEXT,
  op_id       TEXT,
  CHECK (partition IN ('life', 'relationship', 'safety')),
  CHECK (status IN ('pending', 'accepted', 'rejected'))
);

-- §9.3 QQ 侧写入先落这里，不进正式事务
-- 外部通道（QQ 桥接）拿不到本地事务，所以先写一张「待定表」：
-- 桥接只管落行，本地进程再决定采纳（adopted）还是丢弃（discarded）。
-- 这样既不会因为通道侧超时而丢消息，也不会让不可信通道直接改正式数据 ——
-- payload 是待执行的意图，不是已经生效的事实。
-- CHECK (status) 三态：pending 待定、adopted 已采纳、discarded 已丢弃；
-- 已采纳的行由本地事务消费，消费后也不删（留痕）。
CREATE TABLE pending_writes (
  pending_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES persona_config(persona_id),
  platform   TEXT NOT NULL,
  room_id    TEXT,
  contact_id TEXT,
  tool       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK (status IN ('pending', 'adopted', 'discarded'))
);

-- ── 资产（1）────────────────────────────────────────────────

-- §11.8 资产按 sha256 命名
-- 主键就是内容哈希：同一张图被转发十次也只落一份文件，天然去重，也不需要「查重」逻辑。
-- size / mime 冗余存一份，是为了文件被外部删改时还能判断「这里原本应该是什么」；
-- path 存相对库目录的位置，不存绝对路径 —— 换机器/换用户目录后绝对路径立即失效。
CREATE TABLE source_assets (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mime       TEXT,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ── 索引 ────────────────────────────────────────────────────

-- 索引的取舍：全部服务于「按时间倒序取最近 N 条」这一类查询（时间线、最近来源、
-- 待处理队列）。复合索引把 at DESC 也带上，是为了让排序也走索引，
-- 不必为每次读取建一遍临时 B-tree。
-- 反查索引（source_id / target_artifact_id）单独建：外键列在 SQLite 里不会自动加索引，
-- 不建的话「这条来源被谁用过」会退化成全表扫描。
-- 写入侧每次只有一行要维护，索引的维护成本可以接受。
CREATE INDEX idx_events_at ON events (at DESC);
CREATE INDEX idx_events_type ON events (type, at DESC);
CREATE INDEX idx_events_session ON events (session_id, at DESC);
CREATE INDEX idx_events_op ON events (op_id);
CREATE INDEX idx_event_sources_source ON event_sources (source_id);
CREATE INDEX idx_sources_captured ON sources (captured_at DESC);
CREATE INDEX idx_sources_sender ON sources (sender_contact_id, captured_at DESC);
CREATE INDEX idx_sources_room ON sources (room_id, captured_at DESC);
CREATE INDEX idx_sources_window ON sources (activity_window_key);
CREATE INDEX idx_artifacts_kind ON artifacts (kind, updated_at DESC);
CREATE INDEX idx_artifact_evidence_source ON artifact_evidence (source_id);
CREATE INDEX idx_artifact_relations_target ON artifact_relations (target_artifact_id);
CREATE INDEX idx_relationship_signals_contact ON relationship_signals (contact_id, created_at DESC);
CREATE INDEX idx_operations_created ON operations (created_at DESC);
CREATE INDEX idx_proposals_status ON proposals (status, created_at DESC);
CREATE INDEX idx_pending_writes_status ON pending_writes (status, created_at DESC);

-- ── 只追加约束（数据库层兜底，§5.1 / §5.2）──────────────────

-- 为什么用触发器而不是靠代码自觉：被约束的都是「审计底稿」类数据，
-- 一次误 UPDATE 就会让历史无法自证；放在库层，任何驱动、任何脚本都绕不过去，
-- 也不依赖未来的调用方记得读设计文档。
-- 这几张表的共同点：行是「发生过的事实」（消息、事件、账本信号、某个版本的表述），
-- 事实只能新增，不能改写；要修正就写新行（revision / 新事件 / 新信号）。
-- 注意 operations 的 UPDATE 触发器带 WHEN OLD.status = 'ok'：
-- 成功的执行记录冻结，失败行允许补 finished_at / error —— 幂等重试要写回结局，
-- 一刀切全禁会让「重试成功」这件事没地方记。
-- revisions / evidence 只拦 UPDATE 不拦 DELETE 是有意的：它们跟着聚合根级联删除，
-- 删除是对象级的整体动作，不是「改历史」。
CREATE TRIGGER trg_events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER trg_sources_no_update BEFORE UPDATE ON sources
BEGIN SELECT RAISE(ABORT, 'sources is append-only'); END;

CREATE TRIGGER trg_artifact_revisions_no_update BEFORE UPDATE ON artifact_revisions
BEGIN SELECT RAISE(ABORT, 'artifact revisions are immutable'); END;

CREATE TRIGGER trg_artifact_evidence_no_update BEFORE UPDATE ON artifact_evidence
BEGIN SELECT RAISE(ABORT, 'artifact evidence is bound to its revision'); END;

CREATE TRIGGER trg_relationship_signals_no_update BEFORE UPDATE ON relationship_signals
BEGIN SELECT RAISE(ABORT, 'relationship signals is a ledger'); END;

CREATE TRIGGER trg_relationship_signals_no_delete BEFORE DELETE ON relationship_signals
BEGIN SELECT RAISE(ABORT, 'relationship signals is a ledger'); END;

CREATE TRIGGER trg_operations_no_update BEFORE UPDATE ON operations
WHEN OLD.status = 'ok'
BEGIN SELECT RAISE(ABORT, 'operations: 成功记录不可修改'); END;

CREATE TRIGGER trg_operations_no_delete BEFORE DELETE ON operations
BEGIN SELECT RAISE(ABORT, 'operations is append-only'); END;

-- ── FTS5 辅助索引（§11.7；bigram 列由 P2 的写入侧填充，P1 只建表）──

-- 为什么不用 unicode61 之类的中文分词：中文没有明确词边界，按「双字（bigram）」切才稳定，
-- 也不会因为用户没装词典就整段搜不到。
-- bigram_text 放切好的双字串（写侧填），raw_text 留原文片段用于结果回显。
-- kind / ref_id 标 UNINDEXED：它们只用来回到源表，不需要被分词（也分不了），
-- 放进索引既费体积又会让 MATCH 结果混进 id 碎片。
-- P1 只建表不填：写入侧属于 P2，先让 migrate 把结构落好，读侧可以从空表开始。
CREATE VIRTUAL TABLE fts_index USING fts5 (
  kind UNINDEXED,
  ref_id UNINDEXED,
  bigram_text,
  raw_text
);
`

/**
 * 迁移里 seed 只用到 run，收窄到这一面就够了。
 *
 * 故意不接收完整的 Db：seed 是「建库时补一行初始数据」，不该有开事务、
 * 执行任意 SQL、读句柄的能力 —— 手上没有这些能力，就写不出会绕过 migrate()
 * 事务边界的代码。adapter.ts 用一个薄桥接对象满足这个接口。
 */
export interface MigrationSqlStore {
  run(sql: string, params?: readonly unknown[]): unknown
}

/**
 * 一条迁移。
 *
 * 约定与副作用：
 * - sql 会由 migrate() 在同一事务里整段 exec()，所以迁移脚本里不要再写
 *   BEGIN / COMMIT（嵌套事务会直接报错）；
 * - seed 在同一条事务里、sql 之后执行，用同一个 now，保证同一版写入的时间戳一致；
 * - version 必须严格递增且与 SCHEMA_VERSION 对齐；name 进 schema_migrations 供人看，
 *   不要改已经发布过的 name（改了会让历史记录对不上）。
 * - 迁移函数无返回值；失败由 migrate() 抛 PsycheError 并整笔回滚。
 */
export interface Migration {
  version: number
  name: string
  sql: string
  seed?(db: MigrationSqlStore, now: string): void
}

/**
 * v2：成长计算层（设计文档 v14 §21–§22、§26）。
 *
 * 三件事：
 * 1. `proposals.partition` 多一个 `growth` —— Integration 阶段只能由人确认，
 *    确认动作落成一条 growth 提案（SQLite 改不了 CHECK，只能重建表）。
 * 2. 阶段晋级的依据从「一行一条」升级成「一个里程碑一组证据」：
 *    新增 `phase_milestones`，`phase_evidence` 加 `milestone_id` 等列。
 * 3. 外部学习入口与来源元数据：`sources` 加 provider/canonical_url/content_hash/
 *    independence_key/workspace_ref，新增 `learning_jobs`。
 *
 * v2 只加结构，不写数据、不动旧行；`phase_state` 仍然只有 seed 的 trust 一行。
 *
 * 全部语句在 migrate() 的同一个事务里执行，中途任何一条失败都整笔回滚 ——
 * proposals 的重建尤其需要这点：RENAME / CREATE / INSERT SELECT / DROP 四步中间
 * 崩掉会留下「新旧两张 proposals」，那之后的每次打开都会是错的。
 * 被谁调用：只有 adapter.ts 的 migrate()；没有 seed，也不该被业务代码单独引用。
 */
const V2_GROWTH = `
-- 1. proposals 重建：加上 growth 分区
-- 为什么必须重建整张表：SQLite 不支持 ALTER TABLE 改 CHECK 约束，也不支持删列，
-- 而 partition 的合法值集合正好写在 CHECK 里，只能「改名 → 建新表 → 搬数据 → 删旧表」。
-- 顺序有讲究：先 DROP INDEX（否则索引跟着旧表走、重建时会撞名），
-- 再 RENAME，最后在新表建好、数据搬完、旧表 DROP 之后重建同一个索引 ——
-- DROP TABLE 会连带删掉它名下的索引，所以索引只能放在重建末尾补，不能提前。
DROP INDEX IF EXISTS idx_proposals_status;
ALTER TABLE proposals RENAME TO proposals_v1;

CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES persona_config(persona_id),
  partition   TEXT NOT NULL,
  target      TEXT NOT NULL,
  change      TEXT NOT NULL,
  rationale   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  decided_by  TEXT,
  op_id       TEXT,
  CHECK (partition IN ('life', 'relationship', 'safety', 'growth')),
  CHECK (status IN ('pending', 'accepted', 'rejected'))
);

INSERT INTO proposals (proposal_id, persona_id, partition, target, change, rationale,
                       status, created_at, decided_at, decided_by, op_id)
SELECT proposal_id, persona_id, partition, target, change, rationale,
       status, created_at, decided_at, decided_by, op_id
FROM proposals_v1;

DROP TABLE proposals_v1;
CREATE INDEX idx_proposals_status ON proposals (status, created_at DESC);

-- 2. 成长里程碑：一行 = 一次晋级，证据在 phase_evidence 里按 milestone_id 聚合
-- 里程碑是「一次性事件」的记录，所以只增不改：某次晋级发生了就是发生了，
-- 即使后来证据被人要求脱敏，里程碑本身也不删（redacted_at 只是标记）。
-- algorithm_version 一起存：判据阈值将来会调，事后要能区分「当时按哪版判的过了闸」，
-- 否则老库里的晋级在新规则下看起来会像误判。
-- gate 与 to_phase 冗余存（理论上 milestone 的 to_phase 就等于 gate 的下一个阶段），
-- 是为了让人直接读表就能复核「哪道闸把它推到了哪个阶段」，不必再 join phase_state。
-- CHECK 只拦 gate 的枚举，不校验 to_phase 与 gate 的配对关系：
-- 那是派生层的不变量，写在本层会让「补一个中间阶段」变成要改库结构。
CREATE TABLE phase_milestones (
  milestone_id      TEXT PRIMARY KEY,
  persona_id        TEXT NOT NULL REFERENCES persona_config(persona_id),
  gate              TEXT NOT NULL,
  from_phase        TEXT NOT NULL,
  to_phase          TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  redacted_at       TEXT,
  CHECK (gate IN ('trust', 'autonomy', 'initiative', 'integration'))
);

-- 观测台按时间倒序列晋级历史，最新的在最上面。
CREATE INDEX idx_phase_milestones_created ON phase_milestones (created_at DESC);

-- 3. 证据行补齐「属于哪次晋级、哪类依据、独立键是什么」
-- 全部走 ADD COLUMN：SQLite 这里只支持加列（不能改类型、不能加 CHECK、不能删列），
-- 所以是「加列升级」而不是「重建升级」。加列必须可空或带默认值，
-- 因此这些列都不带 NOT NULL —— 老库里已有的证据行没有这些信息，是正常的历史遗留。
-- 新写入侧一律写满（growth.ts 的 INSERT 显式列出全部 13 列），保证 v2 之后的行可复核。
ALTER TABLE phase_evidence ADD COLUMN milestone_id TEXT;
ALTER TABLE phase_evidence ADD COLUMN gate TEXT;
ALTER TABLE phase_evidence ADD COLUMN evidence_type TEXT;
ALTER TABLE phase_evidence ADD COLUMN artifact_revision INTEGER;
ALTER TABLE phase_evidence ADD COLUMN independence_key TEXT;
ALTER TABLE phase_evidence ADD COLUMN algorithm_version TEXT;
ALTER TABLE phase_evidence ADD COLUMN created_at TEXT;
ALTER TABLE phase_evidence ADD COLUMN redacted_at TEXT;

-- 4. 外部学习来源元数据（§23 / §26）
-- 这几个列只对「从外面学来的」来源有意义，聊天消息全留空：
-- provider / canonical_url 记它是从哪儿取的，content_hash 用来判重与判「内容变了」，
-- independence_key 让同一篇文章的多次转载只算一条独立证据，
-- workspace_ref 指回宿主工作区里的文件（大文本不进库）。
-- 同样是 ADD COLUMN：sources 上有 append-only 触发器拦 UPDATE，
-- 但 ALTER TABLE 改的是表结构而不是行，触发器管不到，也不该管。
ALTER TABLE sources ADD COLUMN provider TEXT;
ALTER TABLE sources ADD COLUMN canonical_url TEXT;
ALTER TABLE sources ADD COLUMN content_hash TEXT;
ALTER TABLE sources ADD COLUMN independence_key TEXT;
ALTER TABLE sources ADD COLUMN workspace_ref TEXT;

-- 外部学习作业队列：一次「去外面学点东西」的完整生命周期
-- status 是一串顺序状态（queued → fetching → inspected → extracted → validated →
-- completed），另有 failed / ignored / cancelled 三个终态分支：
-- 之所以把中间态也落库，是为了进程重启后能知道「上次卡在哪一步」，而不是从头再来。
-- origin 区分「谁要学的」：owner_push（人塞的）/ feed（订阅源）/ autonomous_discovery（自己找的）——
-- 自主发现要有额度与审计，三者的放行策略不同，所以必须分开记。
-- provider 只放四种取数通道；将来加通道要新迁移（CHECK 拦着），避免字符串裸奔。
-- attempts 与 error_code 让重试有上限、失败可归因；result_source_refs 是产出的来源 id 数组。
CREATE TABLE learning_jobs (
  job_id             TEXT PRIMARY KEY,
  persona_id         TEXT NOT NULL REFERENCES persona_config(persona_id),
  source_request     TEXT NOT NULL,
  origin             TEXT NOT NULL,
  provider           TEXT NOT NULL,
  topic              TEXT,
  status             TEXT NOT NULL DEFAULT 'queued',
  priority           INTEGER NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  result_source_refs TEXT NOT NULL DEFAULT '[]',
  error_code         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  op_id              TEXT,
  CHECK (origin IN ('owner_push', 'feed', 'autonomous_discovery')),
  CHECK (provider IN ('bilibili', 'web', 'rss', 'file')),
  CHECK (status IN ('queued', 'fetching', 'inspected', 'extracted',
                    'validated', 'completed', 'failed', 'ignored', 'cancelled'))
);

-- 同一个来源同时只允许一条在跑的作业（完成/失败/忽略之后可以再排）
-- 同一个来源同时只允许一条在跑的作业（完成/失败/忽略之后可以再排）
-- 部分索引（带 WHERE）而不是普通唯一索引：只约束「活跃状态」的行，
-- 历史行可以有无数条（同一个来源被学了五次就留五条记录），
-- 但同一时刻不能有两个 worker 抢同一个来源 —— 那会重复抓取、重复计额度。
-- 活跃状态列表必须与上面的 status CHECK 保持同步，漏一个就会多出一个可以重复排队的口子。
CREATE UNIQUE INDEX idx_learning_jobs_active
  ON learning_jobs (source_request)
  WHERE status IN ('queued', 'fetching', 'inspected', 'extracted', 'validated');

CREATE INDEX idx_learning_jobs_status ON learning_jobs (status, priority DESC, created_at DESC);

-- 5. 派生计算的输入版本：事务内递增，用来做缓存键（不能用时间戳，见 §21）
-- 为什么不能用时间戳做缓存键：同一毫秒内可以发生两次写入（批量导入），
-- 时间戳区分不开，缓存就会把旧结果当成新结果；自增计数器则每次写入必然变号。
-- 递增点固定在「写入派生输入的那些事务」末尾（growth.ts 的 advancePhase /
-- commitIntegration），所以版本号变化严格蕴含输入变化 —— 只增不减，
-- 回滚时因为整笔事务一起回滚，也不会出现「版本涨了输入没变」。
ALTER TABLE persona_state ADD COLUMN growth_input_version INTEGER NOT NULL DEFAULT 0;
`

/**
 * v3：写入准入观测（D1-7）。
 *
 * 只建表、不接管写入：P1 阶段 remember 入口先把「质量评估 + 准入判断」
 * 落成一行观测，用来校准阈值；真正按 decision 拦截是 P2 的事。
 *
 * 为什么单表而不是塞进 operations：observations 是「每次写入尝试的判定快照」，
 * 量级远大于 operations（一次 remember 一行），而且允许未来清理/抽样；
 * operations 是幂等凭据，两者生命周期不同。
 * 为什么 signals / reason 用 TEXT 存 JSON：P1 只读回看，不做按信号聚合的查询；
 * 真要聚合时再加生成列或拆表，不在这里提前优化。
 */
const V3_ADMISSION = `
CREATE TABLE admission_observations (
  observation_id TEXT PRIMARY KEY,
  op_id          TEXT NOT NULL,
  source_id      TEXT,
  contact_id     TEXT,
  decision       TEXT NOT NULL,
  quality_score  INTEGER NOT NULL,
  quality_level  TEXT NOT NULL,
  signals        TEXT NOT NULL,
  reason         TEXT,
  policy_version TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  CHECK (decision IN ('accept', 'observe', 'deny')),
  CHECK (quality_level IN ('high', 'medium', 'low'))
);

CREATE INDEX idx_admission_obs_created ON admission_observations (created_at);
CREATE INDEX idx_admission_obs_decision ON admission_observations (decision, created_at);
`

const V4_CAPTURE_KEY = `
-- P2-CAP-1a：给 Source 加一个「外部稳定身份键」，让重复投递可被识别而不是再落一条。
-- capture_key 由调用方按平台约定生成（DSH：sessionId + event.seq），Core 只按
-- (platform, session_ref, capture_key) 判重；不拿正文 Hash 当身份 —— 不同轮次完全可能说同一句话。
-- 不新增表：幂等键是 sources 的一列属性，拆表会让「一条来源」变成两个真相源。
ALTER TABLE sources ADD COLUMN capture_key TEXT;

-- 并发重复由数据库兜底：同身份只允许一条。用部分索引跳过历史行（capture_key 为 NULL 的老数据）。
CREATE UNIQUE INDEX idx_sources_capture_key
  ON sources (platform, session_ref, capture_key)
  WHERE capture_key IS NOT NULL;
`

const V5_CAPTURE_CURSORS = `
-- P2-CAP-1c3-B：历史补采的扫描游标，每个（人格 × 平台 × 会话）一行。
-- 这是可重建的运行态，不是事实：删掉只会导致重读历史（靠 sources 的 capture_key 幂等），
-- 不会丢记忆。所以它允许 UPDATE，而 sources/events 不允许。
--
-- 为什么主键是三元组而不是 sessionRef 单键：同一段历史可能被不同平台各扫一遍
-- （DSH 桌面 / 未来的 QQ 导入），水位必须各算各的，混在一起会漏采。
CREATE TABLE capture_cursors (
  persona_id       TEXT NOT NULL REFERENCES persona_config(persona_id),
  platform         TEXT NOT NULL,
  session_ref      TEXT NOT NULL,
  -- 当前扫描者。每次扫描生成一个独立 UUID：不用 PID —— PID 会复用、也不跨机器唯一，
  -- 拿它当锁归属等于把「谁在写」交给操作系统去猜。
  scan_owner       TEXT,
  -- 租约截止（ISO UTC）。到点即失效，别的 Worker 可以接管；持有者失去租约就停止推进。
  scan_lease_until TEXT,
  -- 本轮目标水位：认领时从同一快照读末尾得到。换快照取 max 会让「扫到哪算完」自相矛盾。
  scan_target_seq  INTEGER NOT NULL DEFAULT -1,
  -- 同一快照内的翻页游标（事件下标，不是 seq）。每轮从 0 重新开始。
  scan_index       INTEGER NOT NULL DEFAULT 0,
  -- 最近一个「处理完成」的实际事件 seq；-1 表示还没处理过任何事件。
  -- 语义是「水位」不是「下一条」：所以推进时写实际 seq，绝不写 last + 1。
  last_scanned_seq INTEGER NOT NULL DEFAULT -1,
  -- Fork 继承前缀的事件数：扫描器据此跳过父会话已处理的前缀（seq < inherited）。
  -- 1c3-B 只存不算；值由 Scanner 从 Persistence 句柄读出来后写这里。
  inherited_event_count INTEGER NOT NULL DEFAULT 0,
  -- idle = 无人扫描；scanning = 有 Worker 拿着租约；
  -- gap = 已知中间有缺口（不冒充连续）；unsupported = 这个宿主/会话不支持补采。
  recovery_state   TEXT NOT NULL DEFAULT 'idle'
                   CHECK (recovery_state IN ('idle', 'scanning', 'gap', 'unsupported')),
  -- 这一轮固定使用的过滤规则版本；忽略统计按版本分组，规则变了不互相污染。
  rule_version     TEXT NOT NULL DEFAULT 'v1',
  -- 忽略统计（JSON，形如 {"v1":{"attempt":3,"system":1}}）。
  -- 与 last_scanned_seq 同一次 CAS 提交：分开写会出现「水位动了、忽略数丢了」的假完成。
  ignored_summary  TEXT NOT NULL DEFAULT '{}',
  -- CAS 版本号：认领/续租/推进/释放全部 +1。旧 claim 拿着旧版本写不进来，
  -- 所以「被接管的 Worker 继续推进」在库层就不成立，不靠调用方自觉。
  cursor_version   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (persona_id, platform, session_ref),
  CHECK (scan_target_seq >= -1),
  CHECK (scan_index >= 0),
  CHECK (last_scanned_seq >= -1),
  CHECK (cursor_version >= 0)
);
`

const V6_REVISION_DISCLOSURE = `
-- P2-FTS5 E3：披露等级属于 revision，不属于 Artifact。
-- 同一段记忆可以在 revision 1 是 public、revision 2 收紧为 restricted —— 披露变化
-- 必须留痕，所以它跟着 revision 走，而不是在 Artifact 上无痕 UPDATE 一个全局标志。
--
-- 默认值刻意是 'restricted' 而不是 'public'：没有标记 ≠ 已确认可披露。
-- 老库升级时所有历史 revision 都会落到 restricted，需要显式分类后才进入普通检索；
-- 「未指定」也不能被悄悄当成放行，写入路径必须自己做选择。
--
-- 为什么用 ALTER TABLE 而不是重建表：SQLite 支持带非 NULL 默认值与 CHECK 的加列，
-- 现有行按默认值补齐；重建表会拷贝全库，风险远大于收益（本机 SQLite 3.53.4）。
ALTER TABLE artifact_revisions
  ADD COLUMN disclosure TEXT NOT NULL DEFAULT 'restricted'
  CHECK (disclosure IN ('public', 'restricted', 'secret'));
`

const V7_DISCLOSURE_GRANTS = `
-- P2-FTS5 E5.3：披露授权凭据（不是分类结果）。
-- 模型工具参数里的 disclosure=public 只是「分类请求」；要把原本受限的敏感内容提升为
-- public，必须由宿主侧可信流程产生一条 grant，并绑定具体内容与操作：
-- content_hash 绑 statement，artifact_id/revision 绑已有结论（新建时为空），
-- used_at 保证一次性，expires_at 可设短 TTL。
-- 这张表只记授权事实，不改变 revision 的 disclosure；revision 的等级仍按不可变版本走。
CREATE TABLE disclosure_grants (
  grant_id          TEXT PRIMARY KEY,
  persona_id        TEXT NOT NULL REFERENCES persona_config(persona_id),
  artifact_id       TEXT,
  revision          INTEGER,
  content_hash      TEXT NOT NULL,
  op_id             TEXT,
  granted_by        TEXT NOT NULL,
  reason            TEXT,
  before_disclosure TEXT NOT NULL,
  after_disclosure  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT,
  used_at           TEXT,
  CHECK (before_disclosure IN ('public', 'restricted', 'secret')),
  CHECK (after_disclosure IN ('public', 'restricted', 'secret'))
);
CREATE INDEX idx_disclosure_grants_hash ON disclosure_grants (content_hash);
CREATE INDEX idx_disclosure_grants_artifact ON disclosure_grants (artifact_id, revision);
`

const V8_GRANT_REVOCATION = `
-- P2-FTS5 E5.5-E1：授权撤销。
-- 撤销不是删除行：grant 行是审计事实，删掉就再也说不清「这条公开当年是谁批的」。
-- 撤销只允许发生在「已签发、未消费」的 grant 上；已消费的授权由 revision 的披露等级
-- 与后续 revision 控制，不能靠撤销历史凭据追溯改写已经公开的内容。
ALTER TABLE disclosure_grants ADD COLUMN revoked_at TEXT;
ALTER TABLE disclosure_grants ADD COLUMN revoked_by TEXT;
`

const V9_DISCLOSURE_SOURCE = `
-- P2-FTS5 E5.5-E1 补强：公开来源。
-- 区分「普通非敏感记忆默认 public」与「用户通过 grant 明确提升为 public」：
-- 一次性授权不能在后续 revise 里被静默继承成永久公开。
-- 值：default（默认策略）、grant（凭据提升）、explicit（显式指定）。
ALTER TABLE artifact_revisions ADD COLUMN disclosure_source TEXT NOT NULL DEFAULT 'default'
  CHECK (disclosure_source IN ('default', 'grant', 'explicit'));
`

const V10_FTS_ROWIDS = `
-- P2-E6-C1：FTS 行定位旁路表。
--
-- 问题：fts_index 的 kind / ref_id 是 UNINDEXED 列。写入侧为了替换同一 head 的旧行，
-- 先 DELETE FROM fts_index WHERE kind = ? AND ref_id = ? —— FTS5 对非 rowid 列只能
-- 全表扫描，于是单条 upsert 是 O(N)，rebuild 逐行 upsert 累计成 O(N²)：
-- 5 万条时 rebuild 约 295 秒、单条写 360ms+（E6-C 实测）。
--
-- 这张表只做一件事：把业务标识映射到 FTS5 的 rowid（B-tree 定位）。
-- 它不是事实源：可以从 fts_index 完全重建；不变量是「每条 FTS 行恰好一条映射，反之亦然」。
-- 写入侧改走这里之后，删除旧行是 O(log N)。
CREATE TABLE fts_rowids (
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id),
  UNIQUE (row_id)
);

-- 旧库回填：已有 fts_index 行的 rowid 直接搬进来（迁移在自己的事务里，失败整笔回滚）。
-- 用 INSERT OR IGNORE 忽略历史上可能出现的一对多脏行，避免升级被一个坏行卡住；
-- 升级后 verifyFtsIndex 会把这种脏行报成 duplicate / mapMismatch，交给人工确认。
INSERT OR IGNORE INTO fts_rowids (kind, ref_id, row_id)
SELECT kind, ref_id, rowid FROM fts_index WHERE ref_id IS NOT NULL;
`

const V11_RECALL_RECEIPT = `
-- P2-Recall R4-B：召回回执。
--
-- 解决什么问题：「这条记忆为什么没进上下文」过去只能靠日志猜。回执把一次召回的
-- 查询形态、候选的原始排名与最终排名、拒绝原因、预算截断分开记下来，事后可以回答
-- 「高相关为什么被拒」「为什么最后只注入这三条」。
--
-- 两条硬约束决定了字段形状：
-- 1) 不存原文，也不存可被拿去比对原文的明文查询——query_hash / scope_hash 是本地密钥 HMAC
--    （域前缀写死在 recall-receipt.ts，密钥文件不在普通备份里）。
-- 2) raw_rank 与 final_rank 必须分开：raw_rank 是检索原始序，final_rank 是准入+排序后的序。
--    「高相关但因为 disclosure/scope/state 被拒」只有拆开才看得出来。
--
-- composition_status 四态与 Composer 对账：
--   pending        召回有候选，等 Composer 结果回填（R4-C 批量事务写入）
--   completed      Composer 已给出结论（selected/composed/truncated 已写）
--   not_applicable 主动 Recall，不经过 Composer 预算
--   interrupted    进程在回填前中断，保留候选行供审计
CREATE TABLE recall_runs (
  run_id TEXT PRIMARY KEY,
  request_id TEXT,
  persona_id TEXT NOT NULL,
  query_hash TEXT,
  query_mode TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_hash TEXT,
  requested_limit INTEGER NOT NULL,
  matched_count INTEGER NOT NULL,
  eligible_count INTEGER NOT NULL,
  returned_count INTEGER NOT NULL,
  abstained INTEGER NOT NULL CHECK (abstained IN (0, 1)),
  composition_status TEXT NOT NULL
    CHECK (composition_status IN ('pending', 'completed', 'not_applicable', 'interrupted')),
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_recall_runs_created ON recall_runs (created_at);

CREATE TABLE recall_candidates (
  run_id TEXT NOT NULL REFERENCES recall_runs (run_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  raw_rank INTEGER,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  reject_reason TEXT,
  final_rank INTEGER,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  composed INTEGER NOT NULL DEFAULT 0 CHECK (composed IN (0, 1)),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  PRIMARY KEY (run_id, artifact_id, revision)
);

CREATE INDEX idx_recall_candidates_run ON recall_candidates (run_id);
`

const V12_QUARANTINED_SOURCES = `
-- R6-CAP-2：被隔离的 Source。
--
-- 背景：pre-step 注入块（role 仍是 user）一度被 Capture 当成用户消息采集，
-- 形成 Runtime Injection → Source → Event → Artifact 的自证环。sources 是
-- append-only 的（触发器禁止 UPDATE），所以「隔离」不能写成 sources.metadata
-- 的原地修改，而是追加一条独立的审计记录：
--   - 原始 Source 保留，来源链可追溯；
--   - 派生层（remember 的 sourceIds）读这张表，命中就拒绝作为证据；
--   - reason 记录为什么隔离（当前只有 runtime-injection），note 留人工说明。
CREATE TABLE quarantined_sources (
  source_id     TEXT PRIMARY KEY,
  reason        TEXT NOT NULL,
  note          TEXT,
  quarantined_at TEXT NOT NULL
);
`

const V14_RECALL_SESSION_TURN = `
-- C2：注入块标签的关联键。
--
-- 背景：pre-step 注入消息里带 source.psyche.runId，UI 要按它找到「这一轮
-- 到底注入了什么」。run_id 本身能唯一确定一条回执，但光有 run_id 不够：
--   - 客户端只被授权看「当前会话 + 当前轮次」；
--   - 越权请求（拿别的会话的 runId）必须被服务端拦掉。
-- 所以要给 recall_runs 补两个范围字段，旧记录保持 NULL = 未知，不补造。
--
-- 为什么不用 request_id：PreStep 写入点原本固定写 null（两边的 id 各自生成），
-- request_id 只做追踪，不承担关联职责。
--
-- 唯一约束：同一会话同一轮只能有一条有效的 pre-step 回执。
-- 用部分索引表达（ALTER TABLE ADD COLUMN 不能加 UNIQUE）；旧数据 session_ref
-- 为 NULL 时不参与约束，迁移不会因历史记录冲突而失败。
ALTER TABLE recall_runs ADD COLUMN session_ref TEXT;
ALTER TABLE recall_runs ADD COLUMN turn INTEGER;

CREATE UNIQUE INDEX idx_recall_runs_pre_step_turn
  ON recall_runs (session_ref, turn)
  WHERE query_mode = 'pre-step' AND session_ref IS NOT NULL AND turn IS NOT NULL;

CREATE INDEX idx_recall_runs_session_turn ON recall_runs (session_ref, turn);
`

const V13_REVISION_DERIVED_STATS = `
-- R6 记忆按钮：允许刷新由证据派生的统计列。
--
-- 背景：「记住这条」给已有结论追加证据（appendEvidence）时，只插入
-- artifact_evidence 行会让明细与 revision 上的统计快照不一致。原来
-- trg_artifact_revisions_no_update 禁止整行 UPDATE，是为了保护「结论内容
-- 不可改写」；这条不变量仍然成立，但 basis_count / independent_evidence_count
-- 本来就是「写入时算好、读侧直接用」的派生快照（schema 注释与 §11 语义），
-- 证据变化时刷新它不算改写结论。
--
-- 边界：
--   - 只放行 basis_count、independent_evidence_count 和 updated_at（行时间戳）；
--   - salience 不放行 —— 它来自调用方传入（remember/revise 的 salience 参数），
--     不是证据派生值，放开会让 appendEvidence 顺带改重要性；
--   - statement/state/subject_refs/payload/confidence/temporal/direct_extraction/
--     disclosure/disclosure_source 以及主键列仍一律拒绝。
DROP TRIGGER IF EXISTS trg_artifact_revisions_no_update;
CREATE TRIGGER trg_artifact_revisions_no_update
BEFORE UPDATE ON artifact_revisions
WHEN NEW.artifact_id IS NOT OLD.artifact_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.state IS NOT OLD.state
  OR NEW.statement IS NOT OLD.statement
  OR NEW.subject_refs IS NOT OLD.subject_refs
  OR NEW.payload IS NOT OLD.payload
  OR NEW.confidence IS NOT OLD.confidence
  OR NEW.salience IS NOT OLD.salience
  OR NEW.temporal IS NOT OLD.temporal
  OR NEW.direct_extraction IS NOT OLD.direct_extraction
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.op_id IS NOT OLD.op_id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.disclosure IS NOT OLD.disclosure
  OR NEW.disclosure_source IS NOT OLD.disclosure_source
BEGIN SELECT RAISE(ABORT, 'artifact revisions are immutable (only derived evidence stats may be refreshed)'); END;
`

/**
 * 全部迁移，按 version 升序；adapter.migrate() 顺序遍历、跳过已应用的。
 *
 * 约束：
 * - 数组必须与 SCHEMA_VERSION 对齐（最后一项的 version 就是它）；
 * - 只能往后追加，不许插入、重排、删改已发布项 —— 老库的 user_version 会跳过它们，
 *   改了旧项等于「新库和旧库结构不同但版本号相同」；
 * - Object.freeze 只冻结数组本身，不改里面的对象，所以也别在别处 push。
 * 副作用：每条迁移由 migrate() 在一个事务里 exec(sql) + seed + 写 schema_migrations，
 * 失败整笔回滚并抛 E_INTERNAL / 驱动错误（见 adapter.migrate）。
 */
const V15_TENSIONS = `
-- P2 Completion Batch 阶段 1：Tension 持久化。
--
-- 背景：tensions.ts 里的状态机（open / investigating / parked / resolved /
-- withdrawn）与探测逻辑早已存在并测过，但记录只在内存里，重启就没了。
-- 这张表只负责「把已经判定过的东西记下来」，不重写状态机：
--   - 追加式版本行：每次状态变化 append 一版，head = MAX(version)；
--   - pair_key 由两侧 artifactId#revision 字典序拼成（与调用顺序无关），
--     用于「同一对结论再次出现」的幂等与历史串联；
--   - 两侧绑 artifactId + revision（版本），不绑对象：结论改了新版，
--     旧张力仍然指向它当初比较的那一版，不会跟着漂；
--   - 不存 Source / Event 正文，event_id 只做回溯指针（事实仍在 Source）。
CREATE TABLE tension_versions (
  tension_id        TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK (version >= 1),
  pair_key          TEXT NOT NULL,
  left_artifact_id  TEXT NOT NULL,
  left_revision     INTEGER NOT NULL,
  left_kind         TEXT NOT NULL,
  left_state        TEXT NOT NULL,
  left_statement    TEXT NOT NULL,
  left_subjects     TEXT NOT NULL DEFAULT '[]',
  right_artifact_id TEXT NOT NULL,
  right_revision    INTEGER NOT NULL,
  right_kind        TEXT NOT NULL,
  right_state       TEXT NOT NULL,
  right_statement   TEXT NOT NULL,
  right_subjects    TEXT NOT NULL DEFAULT '[]',
  kind              TEXT NOT NULL,
  origin            TEXT NOT NULL,
  status            TEXT NOT NULL,
  severity          TEXT NOT NULL,
  basis             TEXT NOT NULL DEFAULT '{}',
  opened_at         TEXT NOT NULL,
  opened_by         TEXT NOT NULL,
  changed_at        TEXT NOT NULL,
  changed_by        TEXT NOT NULL,
  resolution        TEXT,
  note              TEXT,
  event_id          TEXT,
  resolved_artifact_id TEXT,
  resolved_revision INTEGER,
  previous_tension_id  TEXT,
  algorithm_version TEXT NOT NULL,
  PRIMARY KEY (tension_id, version)
);

CREATE INDEX idx_tension_versions_pair ON tension_versions (pair_key);
CREATE INDEX idx_tension_versions_status ON tension_versions (status);
CREATE INDEX idx_tension_versions_left ON tension_versions (left_artifact_id);
CREATE INDEX idx_tension_versions_right ON tension_versions (right_artifact_id);
`

const V16_DECISIONS = `
-- P2 Completion Batch 阶段 2：Decision Receipt。
--
-- 目的：把「这次为什么这么判」记下来，事后能顺着依据回到 Artifact/Evidence/Tension。
-- 它不是第二套事实——事实仍在 Source → Event → Artifact/Evidence；
-- 这里只存「谁、依据什么、做了什么决定、结果如何」。
--
-- 两张表：
--   decision_runs  —— 一次决策一个壳（op_id 唯一，天然幂等）；
--   decision_items —— 这次决策用到了哪些依据、产出了哪条结论（多态引用，不建外键：
--                     跨 artifact/evidence/tension/source 多张表，外键在这里表达不了；
--                     引用有效性交给 psyche-integrity 检查，那是它该干的事）。
CREATE TABLE decision_runs (
  decision_id        TEXT PRIMARY KEY,
  persona_id         TEXT NOT NULL DEFAULT 'main',
  op_id              TEXT NOT NULL,
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  actor              TEXT NOT NULL,
  input_hash         TEXT NOT NULL,
  reason             TEXT,
  result_artifact_id TEXT,
  result_revision    INTEGER,
  created_at         TEXT NOT NULL,
  finalized_at       TEXT,
  schema_version     TEXT NOT NULL DEFAULT '1.0'
);

CREATE UNIQUE INDEX idx_decision_runs_op ON decision_runs (op_id);
CREATE INDEX idx_decision_runs_kind ON decision_runs (kind);
CREATE INDEX idx_decision_runs_status ON decision_runs (status);
CREATE INDEX idx_decision_runs_created ON decision_runs (created_at);

CREATE TABLE decision_items (
  decision_id  TEXT NOT NULL REFERENCES decision_runs (decision_id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  ref_type     TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  ref_revision INTEGER,
  role         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (decision_id, item_id)
);

CREATE INDEX idx_decision_items_ref ON decision_items (ref_type, ref_id);
`

const V17_STANCE_KEY = `
-- P2 Completion Batch 阶段 3：Stance 稳定身份（stance_key）。
--
-- 立场的正文、版本、证据、派生来源全部复用 Artifact 体系（artifacts / artifact_revisions /
-- artifact_evidence / artifact_lineage），这里只补一个「身份键」：
-- 同一个 (stanceGroup, stanceDirection) 只能对应一条 stance Artifact，
-- 否则每次合成都会新建一条，同一立场的版本历史就散了。
--
-- 为什么不用 artifact_lineage 反查：新 belief 加入同一组时，它与旧 stance 之间
-- 还没有 lineage 边；反查只能看到「上一次已经参与过的 belief」，会漏掉新增成员、
-- 把同一条立场重复建出来。身份需要能单条 SQL 直接查到，并由唯一约束兜住并发。
--
-- 可空：非 stance 的 artifact 以及历史遗留 stance 保持 NULL（不补造身份）。
ALTER TABLE artifacts ADD COLUMN stance_key TEXT;

CREATE UNIQUE INDEX idx_artifacts_stance_key ON artifacts (stance_key) WHERE stance_key IS NOT NULL;
`

const V18_DIARY = `
-- P2 Completion Batch 阶段 5：Diary v1（派生叙事 + 版本化）。
--
-- 定位：Diary 不是事实源，是「已经形成的结构化记忆与事件」按日期组织的派生叙事。
-- 三条禁令：不参与 Growth Gate/Decision/Stance 的证据计数；正文不反向写回 Artifact；
-- 召回不建第二套检索/排序/权限（复用 fts_index 的 kind='diary' + 同一套 Scope 规则）。
--
-- 身份：(persona, scope_key, local_date) 唯一。scope_key 取 'global' | 'ct_xxx' | 'rm_xxx'，
-- contact_id / room_id 至多一个非空——与 visibilityConditions 的 surface 语义一致。
--
-- 日粒度用时区换算后的 local_date，period_start/period_end 是该日在该时区下的 UTC 毫秒区间。
-- 时区来自配置而非机器本地时区：换机器不能改变同一段经历落在哪一天。
CREATE TABLE diaries (
  diary_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL DEFAULT 'main',
  scope_key TEXT NOT NULL,
  contact_id TEXT,
  room_id TEXT,
  local_date TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  head_version INTEGER NOT NULL DEFAULT 0,
  source_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_diaries_key ON diaries (persona_id, scope_key, local_date);
CREATE INDEX idx_diaries_date ON diaries (local_date);

-- 版本 append-only：重新生成只追加新版本，不 UPDATE 历史正文。
-- source_refs / tension_refs 保存来源引用（可回查），content_hash 用于「无实质变化不新增版本」。
CREATE TABLE diary_versions (
  diary_id TEXT NOT NULL REFERENCES diaries(diary_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  tension_refs TEXT NOT NULL DEFAULT '[]',
  algorithm_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (diary_id, version)
);

-- 决策回执的结果指针：decision_items 早已支持 ref_type='diary'，这里补一个直接结果列，
-- 免得把 diary id 塞进 result_artifact_id（那是 Artifact 的位置）。
ALTER TABLE decision_runs ADD COLUMN result_diary_id TEXT;
`

const V19_MOOD_META = `
-- P3-A B1：情绪状态机的单行元数据 + 历史幂等索引。
--
-- 为什么不是给 global_mood_state 加列：那张表的粒度是「每个 persona 每个维度一行」（33 行/人）。
-- state_version 的语义是「一次完整更新 +1」，写进 33 行会变成 33 份重复版本，且无法判断整体一致性。
-- 因此单独一张单行表承载聚合根级元数据；不建第二套事实源，也不改 global_mood_state 结构。
CREATE TABLE mood_meta (
  persona_id     TEXT PRIMARY KEY REFERENCES persona_config(persona_id),
  state_version  INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 0,
  last_op_id     TEXT,
  updated_at     TEXT NOT NULL
);

-- 一次 update 会写 33 行 history（每维一行）。唯一索引保证「同一 opId、同一维度」只记一次；
-- op_id IS NULL 的旧行（P3-A 之前不存在，但保留兼容）不参与唯一约束。
CREATE UNIQUE INDEX idx_global_mood_history_op
  ON global_mood_history (persona_id, op_id, dimension)
  WHERE op_id IS NOT NULL;
`

const V20_AFFECT_HISTORY_APPEND_ONLY = `
-- P3-B-2-0：contact_affect_history 的数据库级只追加保护。
--
-- 背景：Affect（B-2）会依赖这张历史表做冷却回放与审计；如果任何写路径能 UPDATE/DELETE
-- 历史行，「从历史重算」就不再可信。已有 relationship_signals 的同类触发器先例。
--
-- DELETE 触发器带 WHEN EXISTS(contacts)：contact_affect_history 对 contacts 是
-- ON DELETE CASCADE，删 Contact 时父行已先删除，此时 EXISTS 为假、放行；手工删历史行
-- （父行还在）则被拦。裸 BEFORE DELETE 会连合法的级联删除一起挡掉。
CREATE TRIGGER trg_contact_affect_history_no_update BEFORE UPDATE ON contact_affect_history
BEGIN SELECT RAISE(ABORT, 'contact affect history is append-only'); END;

CREATE TRIGGER trg_contact_affect_history_no_delete BEFORE DELETE ON contact_affect_history
WHEN EXISTS (SELECT 1 FROM contacts WHERE contact_id = OLD.contact_id)
BEGIN SELECT RAISE(ABORT, 'contact affect history is append-only'); END;
`

const V21_PROACTIVE_OUTBOX = `
-- P3-C-3a：主动联系发件箱。
--
-- 设计（docs/design/p3-c-3a-outbox-implementation.md）：
--   - approval 与 enqueue 是一个原子业务操作：行存在即代表「Owner 已批准且入队成功」；
--   - payload_text 是真正获批的正文，后续草稿修改不影响已入队内容；
--   - 审批绑定字段入队后不可变（触发器保护），状态/attempts/receipt/时间字段可按状态机更新；
--   - capacity = pending + dispatching + unknown（unknown 待 Owner 核验，不自动清理）。
CREATE TABLE proactive_outbox (
  outbox_id          TEXT PRIMARY KEY,
  approval_id        TEXT NOT NULL UNIQUE,
  draft_id           TEXT NOT NULL,
  draft_revision     INTEGER NOT NULL,
  draft_hash         TEXT NOT NULL,
  contact_id         TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  platform           TEXT NOT NULL,
  stable_user_id     TEXT NOT NULL,
  transport_id       TEXT NOT NULL,
  target_kind        TEXT NOT NULL CHECK (target_kind IN ('private', 'group')),
  payload_text       TEXT NOT NULL,
  text_hash          TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN
                       ('pending', 'dispatching', 'sent', 'failed', 'unknown', 'expired', 'cancelled')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error_code    TEXT,
  receipt            TEXT,
  decided_by         TEXT NOT NULL,
  approval_decided_at TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  retry_at           TEXT,
  dispatch_started_at TEXT,
  sent_at            TEXT,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_proactive_outbox_due ON proactive_outbox (status, retry_at);
CREATE INDEX idx_proactive_outbox_expiry ON proactive_outbox (expires_at);
CREATE INDEX idx_proactive_outbox_contact ON proactive_outbox (contact_id, status);
CREATE INDEX idx_proactive_outbox_sent ON proactive_outbox (sent_at);

-- 审批内容不可变：不只靠 Store 校验，数据库层也拒绝改这些列。
-- 状态迁移只更新 status/attempts/last_error_code/receipt/retry_at/dispatch_started_at/sent_at/updated_at。
CREATE TRIGGER trg_proactive_outbox_binding_immutable
BEFORE UPDATE OF approval_id, draft_id, draft_revision, draft_hash, contact_id,
  platform, stable_user_id, transport_id, payload_text, text_hash, decided_by, approval_decided_at
ON proactive_outbox
BEGIN
  SELECT RAISE(ABORT, 'proactive outbox approval binding is immutable');
END;
`

const V22_ROOM_INTAKE = `
-- 先显式预检；冲突整版回滚，不修剪/合并历史事实。
CREATE TEMP TABLE p4d1_migration_guard (ok INTEGER CONSTRAINT p4d1_duplicate_group_identity CHECK (ok=1));
INSERT INTO p4d1_migration_guard
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM rooms WHERE channel='group' AND external_room_id IS NOT NULL
  GROUP BY persona_id,platform,external_room_id HAVING COUNT(*)>1
) OR EXISTS (
  SELECT 1 FROM sources s JOIN rooms r ON r.room_id=s.room_id
  WHERE s.channel='group' AND r.channel='group' AND s.platform=r.platform AND s.persona_id=r.persona_id
    AND s.message_id IS NOT NULL AND s.message_id<>''
  GROUP BY s.platform,s.room_id,s.message_id HAVING COUNT(*)>1
);
DROP TABLE p4d1_migration_guard;
CREATE UNIQUE INDEX idx_rooms_group_identity ON rooms(persona_id,platform,external_room_id)
 WHERE channel='group' AND external_room_id IS NOT NULL;
CREATE TABLE room_message_seq (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  platform TEXT NOT NULL,
  message_id TEXT NOT NULL,
  room_seq INTEGER NOT NULL CHECK(room_seq>0),
  source_id TEXT UNIQUE REFERENCES sources(source_id),
  event_id TEXT REFERENCES events(event_id),
  received_at TEXT NOT NULL,
  PRIMARY KEY(room_id,room_seq),
  UNIQUE(platform,room_id,message_id),
  CHECK(event_id IS NULL OR source_id IS NOT NULL)
);
CREATE TABLE room_participation_state (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0),
  read_through_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_through_seq>=0 AND read_through_seq<=last_seq),
  participation_state TEXT NOT NULL DEFAULT 'idle' CHECK(participation_state IN ('idle','running','interrupted')),
  updated_at TEXT NOT NULL
);
-- 历史有效 Source 按已落库顺序编号；绝不使用 captured_at 代替接入序号。
INSERT INTO room_message_seq(room_id,platform,message_id,room_seq,source_id,event_id,received_at)
 SELECT s.room_id,s.platform,s.message_id,
   ROW_NUMBER() OVER(PARTITION BY s.room_id ORDER BY s.rowid),s.source_id,NULL,s.captured_at
 FROM sources s JOIN rooms r ON r.room_id=s.room_id
 WHERE s.channel='group' AND r.channel='group' AND s.platform=r.platform AND s.persona_id=r.persona_id
   AND s.message_id IS NOT NULL AND s.message_id<>'';
INSERT INTO room_participation_state(room_id,last_seq,updated_at)
 SELECT r.room_id,COALESCE(MAX(m.room_seq),0),r.updated_at FROM rooms r
 LEFT JOIN room_message_seq m ON m.room_id=r.room_id WHERE r.channel='group' GROUP BY r.room_id;
CREATE TRIGGER trg_room_message_seq_no_update BEFORE UPDATE ON room_message_seq
 BEGIN SELECT RAISE(ABORT,'room message sequence is append-only'); END;
CREATE TRIGGER trg_room_message_seq_no_delete BEFORE DELETE ON room_message_seq
 BEGIN SELECT RAISE(ABORT,'room message sequence is append-only'); END;
CREATE TRIGGER trg_room_read_watermark_monotonic BEFORE UPDATE ON room_participation_state
 WHEN NEW.read_through_seq<OLD.read_through_seq OR NEW.last_seq<OLD.last_seq
 BEGIN SELECT RAISE(ABORT,'room watermarks cannot move backwards'); END;
CREATE TRIGGER trg_room_message_seq_binding BEFORE INSERT ON room_message_seq
 WHEN NOT EXISTS(SELECT 1 FROM rooms r WHERE r.room_id=NEW.room_id AND r.channel='group' AND r.platform=NEW.platform)
 OR (NEW.source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sources s JOIN rooms r ON r.room_id=s.room_id
   WHERE s.source_id=NEW.source_id AND s.room_id=NEW.room_id AND s.platform=NEW.platform AND s.channel='group' AND s.persona_id=r.persona_id))
 OR (NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM events e JOIN event_sources es ON es.event_id=e.event_id
   WHERE e.event_id=NEW.event_id AND e.room_id=NEW.room_id AND es.source_id=NEW.source_id))
 BEGIN SELECT RAISE(ABORT,'room message evidence binding mismatch'); END;
`

// D-2 records reference Source/Event; scheduling tables never contain message bodies.
const V23_GROUP_SCHEDULING = `
CREATE TEMP TABLE group_v23_precheck(n INTEGER CHECK(n=0));
INSERT INTO group_v23_precheck SELECT COUNT(*) FROM room_participation_state WHERE read_through_seq<>0;
INSERT INTO group_v23_precheck SELECT COUNT(*) FROM room_message_seq m LEFT JOIN sources s ON s.source_id=m.source_id
 WHERE m.source_id IS NOT NULL AND (s.source_id IS NULL OR s.room_id<>m.room_id OR s.platform<>m.platform OR s.channel<>'group');
DROP TABLE group_v23_precheck;
CREATE TABLE room_schedule_owner (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0),
 owner_id TEXT NOT NULL DEFAULT '', last_decision_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_decision_ms>=0)
);
INSERT INTO room_schedule_owner(singleton) VALUES(1);
CREATE TABLE room_triggers (
 room_id TEXT NOT NULL, room_seq INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES sources(source_id),
 policy_hash TEXT NOT NULL, account_key TEXT NOT NULL, transport_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('armed','claimed','suppressed','consumed')), reason TEXT,
 created_ms INTEGER NOT NULL, last_arrival_ms INTEGER NOT NULL, overflowed INTEGER NOT NULL DEFAULT 0 CHECK(overflowed IN (0,1)),
 PRIMARY KEY(room_id,room_seq), FOREIGN KEY(room_id,room_seq) REFERENCES room_message_seq(room_id,room_seq)
);
CREATE TABLE room_batches (
 batch_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id), epoch INTEGER NOT NULL,
 account_key TEXT NOT NULL, transport_id TEXT NOT NULL, policy_hash TEXT NOT NULL, policy_json TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, snapshot_last_seq INTEGER NOT NULL,
 projection_hash TEXT NOT NULL, member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 20),
 session_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('queued','submitting','running','finalizing','completed','incomplete','interrupted','suppressed')),
 host_turn INTEGER, last_step INTEGER, reason TEXT, created_ms INTEGER NOT NULL, started_ms INTEGER,
 updated_ms INTEGER NOT NULL, UNIQUE(batch_id,room_id)
);
CREATE UNIQUE INDEX uq_room_active_batch ON room_batches(room_id) WHERE state IN ('submitting','running','finalizing');
CREATE INDEX idx_room_batch_queue ON room_batches(state,created_ms);
CREATE TABLE room_batch_members (
 batch_id TEXT NOT NULL, room_id TEXT NOT NULL, room_seq INTEGER NOT NULL,
 source_id TEXT NOT NULL REFERENCES sources(source_id), event_id TEXT NOT NULL REFERENCES events(event_id),
 source_hash TEXT NOT NULL, projection_hash TEXT NOT NULL, chars INTEGER NOT NULL CHECK(chars>0),
 sender_alias TEXT NOT NULL, is_trigger INTEGER NOT NULL CHECK(is_trigger IN (0,1)), released_ms INTEGER,
 PRIMARY KEY(batch_id,room_seq), FOREIGN KEY(batch_id,room_id) REFERENCES room_batches(batch_id,room_id),
 FOREIGN KEY(room_id,room_seq) REFERENCES room_message_seq(room_id,room_seq)
);
CREATE UNIQUE INDEX uq_room_member_lease ON room_batch_members(room_id,room_seq) WHERE released_ms IS NULL;
CREATE TABLE room_input_receipts (
 receipt_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES room_batches(batch_id),
 kind TEXT NOT NULL CHECK(kind IN ('input','finish','turn')), attempt_id TEXT NOT NULL,
 receipt_json TEXT NOT NULL, created_ms INTEGER NOT NULL, UNIQUE(batch_id,kind,attempt_id)
);
CREATE TABLE room_seq_confirmations (
 room_id TEXT NOT NULL, room_seq INTEGER NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('policy_omitted','model_processed')),
 batch_id TEXT REFERENCES room_batches(batch_id), receipt_id TEXT REFERENCES room_input_receipts(receipt_id),
 confirmed_ms INTEGER NOT NULL, PRIMARY KEY(room_id,room_seq),
 FOREIGN KEY(room_id,room_seq) REFERENCES room_message_seq(room_id,room_seq),
 CHECK((disposition='policy_omitted' AND batch_id IS NULL AND receipt_id IS NULL) OR
       (disposition='model_processed' AND batch_id IS NOT NULL AND receipt_id IS NOT NULL))
);
CREATE TABLE room_reply_intents (
 intent_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL UNIQUE REFERENCES room_batches(batch_id),
 room_id TEXT NOT NULL REFERENCES rooms(room_id), epoch INTEGER NOT NULL, account_key TEXT NOT NULL,
 transport_id TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE REFERENCES sources(source_id), text_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','sent','failed','unknown','cancelled')),
 platform_message_id TEXT, error_code TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE TABLE room_reply_bindings (
 platform TEXT NOT NULL CHECK(platform='qq'), account_key TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(room_id),
 platform_message_id TEXT NOT NULL, intent_id TEXT NOT NULL UNIQUE REFERENCES room_reply_intents(intent_id),
 source_id TEXT NOT NULL REFERENCES sources(source_id), created_ms INTEGER NOT NULL,
 PRIMARY KEY(platform,account_key,room_id,platform_message_id)
);
CREATE TRIGGER trg_group_owner_monotonic BEFORE UPDATE ON room_schedule_owner
 WHEN NEW.singleton<>OLD.singleton OR NEW.epoch<OLD.epoch OR NEW.last_decision_ms<OLD.last_decision_ms
 BEGIN SELECT RAISE(ABORT,'group owner cannot move backwards'); END;
CREATE TRIGGER trg_group_member_binding BEFORE INSERT ON room_batch_members
 WHEN NOT EXISTS(SELECT 1 FROM room_message_seq m JOIN sources s ON s.source_id=m.source_id
 JOIN event_sources es ON es.source_id=s.source_id JOIN events e ON e.event_id=es.event_id
 WHERE m.room_id=NEW.room_id AND m.room_seq=NEW.room_seq AND m.source_id=NEW.source_id
 AND s.room_id=NEW.room_id AND s.channel='group' AND s.origin='user' AND e.room_id=NEW.room_id AND e.event_id=NEW.event_id)
 BEGIN SELECT RAISE(ABORT,'group member evidence mismatch'); END;
CREATE TRIGGER trg_group_delivery_binding BEFORE INSERT ON room_reply_bindings
 WHEN NOT EXISTS(SELECT 1 FROM room_reply_intents i JOIN sources s ON s.source_id=i.source_id
 WHERE i.intent_id=NEW.intent_id AND i.room_id=NEW.room_id AND i.account_key=NEW.account_key
 AND i.source_id=NEW.source_id AND i.state='sent' AND i.platform_message_id=NEW.platform_message_id
 AND s.room_id=NEW.room_id AND s.origin='self' AND s.channel='group' AND s.platform='qq')
 BEGIN SELECT RAISE(ABORT,'group delivery evidence mismatch'); END;
` + [
 ['room_schedule_owner',''],
 ['room_triggers','room_id,room_seq,source_id,policy_hash,account_key,transport_id,created_ms'],
 ['room_batches','batch_id,room_id,epoch,account_key,transport_id,policy_hash,policy_json,provider,model,snapshot_last_seq,projection_hash,member_count,session_id,message_id,created_ms'],
 ['room_batch_members','batch_id,room_id,room_seq,source_id,event_id,source_hash,projection_hash,chars,sender_alias,is_trigger'],
 ['room_input_receipts','*'], ['room_seq_confirmations','*'],
 ['room_reply_intents','intent_id,batch_id,room_id,epoch,account_key,transport_id,source_id,text_hash,created_ms'],
 ['room_reply_bindings','*'],
].map(([table,columns]) => `
CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
 BEGIN SELECT RAISE(ABORT,'group record cannot be deleted'); END;
${columns ? `CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE${columns==='*'?'':` OF ${columns}`} ON ${table}
 BEGIN SELECT RAISE(ABORT,'group evidence is immutable'); END;` : ''}
`).join('');

const V24_QQ_REPLY_OUTBOX = `
CREATE TABLE qq_reply_outbox (
 reply_id TEXT PRIMARY KEY,
 persona_id TEXT NOT NULL,
 contact_id TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
 platform TEXT NOT NULL CHECK(platform='qq'),
 stable_user_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 session_seq INTEGER NOT NULL CHECK(session_seq>0),
 turn INTEGER, step INTEGER,
 transport_id TEXT NOT NULL,
 target_kind TEXT NOT NULL CHECK(target_kind='private'),
 payload_text TEXT NOT NULL CHECK(length(payload_text)>0),
 text_hash TEXT NOT NULL,
 quote_message_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','dispatching','sent','failed','unknown','expired','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error_code TEXT,
 receipt TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 retry_at TEXT,
 dispatch_started_at TEXT,
 sent_at TEXT,
 terminal_at TEXT,
 updated_at TEXT NOT NULL,
 UNIQUE(persona_id, contact_id, session_id, session_seq)
);
CREATE INDEX idx_qq_reply_outbox_due ON qq_reply_outbox(status, retry_at);
CREATE INDEX idx_qq_reply_outbox_expiry ON qq_reply_outbox(expires_at);
CREATE INDEX idx_qq_reply_outbox_contact ON qq_reply_outbox(contact_id, status, created_at);
CREATE INDEX idx_qq_reply_outbox_session ON qq_reply_outbox(session_id);
CREATE TRIGGER trg_qq_reply_outbox_binding_immutable BEFORE UPDATE OF
 reply_id, persona_id, contact_id, platform, stable_user_id, session_id, session_seq,
 transport_id, target_kind, payload_text, text_hash, quote_message_id
 ON qq_reply_outbox
 BEGIN SELECT RAISE(ABORT,'qq reply outbox binding is immutable'); END;
CREATE TRIGGER trg_qq_reply_outbox_terminal_once BEFORE UPDATE OF terminal_at ON qq_reply_outbox
 WHEN OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at
 BEGIN SELECT RAISE(ABORT,'qq reply outbox terminal_at is immutable once set'); END;
`;

const V25_GROWTH_REFLECTION = `
-- P5-3a：成长反思候选（rule-only v1，只生成候选，不确认、不生效、不投影）。
-- 三张表把「一次反思」「候选」「候选证据」分开：
--   - growth_reflections：trigger_key 同一批 Source 只跑一次；终态 proposed/no_change 去重，
--     failed/skipped_budget 复用原行重试（attempt+1），预算跳过不消耗执行额度；
--   - growth_candidates：semantic_key 只约束活动候选（partial unique index），历史候选保留；
--   - growth_candidate_sources：记录候选用到的 Source 与独立键，合并新证据时事务内重算。
CREATE TABLE growth_reflections (
  reflection_id   TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL REFERENCES persona_config(persona_id),
  trigger_key     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('evaluating','proposed','no_change','failed','skipped_budget')),
  attempt         INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  source_count    INTEGER NOT NULL DEFAULT 0 CHECK(source_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
  scope           TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  error_reason    TEXT,
  next_eligible_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(persona_id, trigger_key)
);
CREATE INDEX idx_growth_reflections_status ON growth_reflections(persona_id, status, started_at);
CREATE INDEX idx_growth_reflections_finished ON growth_reflections(persona_id, finished_at);

CREATE TABLE growth_candidates (
  candidate_id     TEXT PRIMARY KEY,
  persona_id       TEXT NOT NULL REFERENCES persona_config(persona_id),
  reflection_id    TEXT NOT NULL REFERENCES growth_reflections(reflection_id) ON DELETE CASCADE,
  semantic_key     TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('new_fact','revise_stance','new_habit','identity_growth')),
  subject_refs     TEXT NOT NULL DEFAULT '[]',
  predicate        TEXT NOT NULL,
  statement        TEXT NOT NULL,
  scope            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('proposed','superseded','rejected')),
  independent_count INTEGER NOT NULL DEFAULT 0 CHECK(independent_count >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_growth_candidates_active
  ON growth_candidates(persona_id, semantic_key) WHERE status = 'proposed';
CREATE INDEX idx_growth_candidates_status ON growth_candidates(persona_id, status, created_at);

CREATE TABLE growth_candidate_sources (
  candidate_id     TEXT NOT NULL REFERENCES growth_candidates(candidate_id) ON DELETE CASCADE,
  source_id        TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  independence_key TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY(candidate_id, source_id)
);
`;

const V26_GROWTH_CONFIRMATION = `
-- P5-3b：候选确认/否定与撤回（append-only 决策账本）。
-- 候选表扩状态：confirmed / withdrawn 与 status 物化；决策本身仍以 growth_confirmations 为唯一事实源。
-- 活动候选唯一索引改为普通索引：已确认但仍是 proposed 的旧行不得阻塞同一 semantic_key 的新候选；
-- 未决策候选的唯一性由 reflectGrowthCandidates 在 BEGIN IMMEDIATE 内检查。
CREATE TABLE growth_candidates_v26 (
  candidate_id     TEXT PRIMARY KEY,
  persona_id       TEXT NOT NULL REFERENCES persona_config(persona_id),
  reflection_id    TEXT NOT NULL REFERENCES growth_reflections(reflection_id) ON DELETE CASCADE,
  semantic_key     TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('new_fact','revise_stance','new_habit','identity_growth')),
  subject_refs     TEXT NOT NULL DEFAULT '[]',
  predicate        TEXT NOT NULL,
  statement        TEXT NOT NULL,
  scope            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('proposed','superseded','rejected','confirmed','withdrawn')),
  independent_count INTEGER NOT NULL DEFAULT 0 CHECK(independent_count >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
INSERT INTO growth_candidates_v26 (
  candidate_id, persona_id, reflection_id, semantic_key, type, subject_refs, predicate,
  statement, scope, status, independent_count, created_at, updated_at
) SELECT
  candidate_id, persona_id, reflection_id, semantic_key, type, subject_refs, predicate,
  statement, scope, status, independent_count, created_at, updated_at
FROM growth_candidates;

CREATE TABLE growth_candidate_sources_v26 (
  candidate_id     TEXT NOT NULL REFERENCES growth_candidates_v26(candidate_id) ON DELETE CASCADE,
  source_id        TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  independence_key TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY(candidate_id, source_id)
);
INSERT INTO growth_candidate_sources_v26 (candidate_id, source_id, independence_key, created_at)
SELECT candidate_id, source_id, independence_key, created_at FROM growth_candidate_sources;

DROP TABLE growth_candidate_sources;
DROP TABLE growth_candidates;
ALTER TABLE growth_candidates_v26 RENAME TO growth_candidates;
ALTER TABLE growth_candidate_sources_v26 RENAME TO growth_candidate_sources;
CREATE INDEX idx_growth_candidates_active_lookup
  ON growth_candidates(persona_id, semantic_key) WHERE status = 'proposed';
CREATE INDEX idx_growth_candidates_status ON growth_candidates(persona_id, status, created_at);
CREATE INDEX idx_growth_candidate_sources_source ON growth_candidate_sources(source_id);

CREATE TABLE growth_confirmations (
  confirmation_id  TEXT PRIMARY KEY,
  candidate_id     TEXT NOT NULL REFERENCES growth_candidates(candidate_id) ON DELETE CASCADE,
  persona_id       TEXT NOT NULL REFERENCES persona_config(persona_id),
  decision         TEXT NOT NULL CHECK(decision IN ('confirm','reject','withdraw')),
  decided_by       TEXT NOT NULL,
  decided_at       TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  statement        TEXT NOT NULL,
  scope            TEXT NOT NULL,
  evidence_count   INTEGER NOT NULL DEFAULT 0 CHECK(evidence_count >= 0),
  sources_hash     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_growth_confirmations_candidate
  ON growth_confirmations(candidate_id, decided_at);
CREATE INDEX idx_growth_confirmations_decision
  ON growth_confirmations(persona_id, decision, decided_at);
`;

const V27_MEMORY_HYGIENE = `
-- P5-5：记忆整理与淡忘。两张 append-only 事件表，当前态由最大事件 id 决定。
-- merge：canonical 吸收 duplicate 的召回位，但 evidence / revision / 历史全部不动。
-- archive：从默认召回排除；restore 追加一条 restore 事件，不删除任何数据。
CREATE TABLE memory_merge_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id            TEXT NOT NULL REFERENCES persona_config(persona_id),
  canonical_artifact_id TEXT NOT NULL,
  duplicate_artifact_id TEXT NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('merge', 'unmerge')),
  at                    TEXT NOT NULL,
  by                    TEXT NOT NULL,
  reason                TEXT,
  CHECK (canonical_artifact_id <> duplicate_artifact_id)
);
CREATE INDEX idx_memory_merge_duplicate ON memory_merge_events(duplicate_artifact_id, id);
CREATE INDEX idx_memory_merge_canonical ON memory_merge_events(canonical_artifact_id, id);

CREATE TABLE memory_archive_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL REFERENCES persona_config(persona_id),
  artifact_id TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('archive', 'restore')),
  at          TEXT NOT NULL,
  by          TEXT NOT NULL,
  reason      TEXT
);
CREATE INDEX idx_memory_archive_artifact ON memory_archive_events(artifact_id, id);
`;

const V28_EXTERNAL_SOURCE = `
-- P5-6：外界来源登记与隔离。登记行不可变，删除/过期清理走 append-only 事件。
-- external_sources 只引用已有 Core Source，不复制正文；content_sha256 由调用方原始字节计算。
-- 风险标记只是 best-effort 提示，不作为准入依据。
CREATE TABLE external_sources (
  source_id         TEXT PRIMARY KEY REFERENCES sources(source_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('web', 'file', 'group')),
  provenance        TEXT NOT NULL,
  content_sha256    TEXT NOT NULL,
  risk_flags        TEXT NOT NULL DEFAULT '[]',
  scope             TEXT NOT NULL CHECK (scope IN ('personal', 'contact', 'room')),
  scope_ref         TEXT,
  disclosure        TEXT NOT NULL,
  retention_until   INTEGER,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK ((scope = 'room' AND scope_ref IS NOT NULL) OR (scope <> 'room'))
);
CREATE INDEX idx_external_sources_kind ON external_sources(kind);
CREATE INDEX idx_external_sources_retention ON external_sources(retention_until);

CREATE TABLE external_source_deletion_events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  TEXT NOT NULL REFERENCES external_sources(source_id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('delete', 'purge')),
  at         INTEGER NOT NULL,
  by         TEXT NOT NULL,
  reason     TEXT
);
CREATE INDEX idx_external_source_deletion_source ON external_source_deletion_events(source_id, event_id);
`;

const V29_GROWTH_REFLECTION_BUDGET = `
-- P5-R-2：成长反思的稳定水位与每 Contact 配额。
-- 逐条 Source 的已处理账本替代时间水位；只有 proposed/no_change 终态写入。
-- 迁移把现有 sources 回填为 legacy 基线（reflection_id/contact_key 为 NULL），
-- 表示「不再回放历史」，这些行不参与配额计数。
ALTER TABLE growth_reflections ADD COLUMN source_ids TEXT;

CREATE TABLE growth_reflection_processed_sources (
  persona_id     TEXT NOT NULL,
  source_id      TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  reflection_id  TEXT REFERENCES growth_reflections(reflection_id) ON DELETE SET NULL,
  contact_key    TEXT,
  processed_at   TEXT NOT NULL,
  PRIMARY KEY (persona_id, source_id)
);
CREATE INDEX idx_growth_reflection_processed_contact
  ON growth_reflection_processed_sources(persona_id, contact_key, processed_at);

INSERT INTO growth_reflection_processed_sources
  (persona_id, source_id, reflection_id, contact_key, processed_at)
SELECT persona_id, source_id, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM sources;
`;

const V30_EXTERNAL_SOURCE_ERASE = `
-- P5-R-3a：外部来源物理擦除的 append-only 事件账本。
-- 状态机：logical_deleted -> erase_pending -> erased / erase_failed。
-- 当前态按最新 erase_event_id 判定；正文擦除仍保留 Source 身份与审计事件。
CREATE TABLE external_source_erase_events (
  erase_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id      TEXT NOT NULL REFERENCES sources(source_id),
  action         TEXT NOT NULL CHECK (action IN ('erase_request','erase_started','erase_failed','erased')),
  stage          TEXT,
  error_code     TEXT,
  at             TEXT NOT NULL,
  by             TEXT NOT NULL,
  proof_digest   TEXT
);
CREATE INDEX idx_external_erase_source
  ON external_source_erase_events(source_id, erase_event_id);
CREATE INDEX idx_external_erase_action
  ON external_source_erase_events(action, at);

CREATE TRIGGER trg_external_erase_no_update BEFORE UPDATE ON external_source_erase_events
BEGIN SELECT RAISE(ABORT, 'external source erase events are append-only'); END;

CREATE TRIGGER trg_external_erase_no_delete BEFORE DELETE ON external_source_erase_events
BEGIN SELECT RAISE(ABORT, 'external source erase events are append-only'); END;
`;

const V31_INTENTION = `
-- P6-2：自主意愿的持久化与选择反馈（只读观察，不产生行动）。
-- 状态机：internal -> deferred -> abandoned/expired；终态不可原地复活。
-- 语义键唯一：同一 persona 下，非终态同一 semantic_key 只保留一条。
CREATE TABLE intentions (
  intention_id       TEXT PRIMARY KEY,
  persona_id         TEXT NOT NULL,
  attention_id       TEXT NOT NULL,
  semantic_key       TEXT NOT NULL,
  type               TEXT NOT NULL,
  statement          TEXT NOT NULL,
  score              REAL NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('internal','deferred','abandoned','expired')),
  scope              TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  evidence_digest    TEXT NOT NULL,
  reason_code        TEXT,
  reevaluate_at      INTEGER,
  reevaluate_condition TEXT,
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  terminal_at        INTEGER
);
CREATE UNIQUE INDEX idx_intentions_active_semantic
  ON intentions(persona_id, semantic_key)
  WHERE status IN ('internal','deferred');
CREATE INDEX idx_intentions_active
  ON intentions(persona_id, status, expires_at);
CREATE INDEX idx_intentions_created
  ON intentions(persona_id, created_at);

CREATE TABLE intention_events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  intention_id  TEXT NOT NULL,
  persona_id    TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('created','chosen','deferred','abandoned','expired','observed')),
  at            INTEGER NOT NULL,
  reason_code   TEXT,
  detail_json   TEXT
);
CREATE INDEX idx_intention_events_one
  ON intention_events(intention_id, event_id);
CREATE INDEX idx_intention_events_persona
  ON intention_events(persona_id, event_id);

CREATE TRIGGER trg_intention_events_no_update BEFORE UPDATE ON intention_events
BEGIN SELECT RAISE(ABORT, 'intention events are append-only'); END;

CREATE TRIGGER trg_intention_events_no_delete BEFORE DELETE ON intention_events
BEGIN SELECT RAISE(ABORT, 'intention events are append-only'); END;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'p1-initial',
    sql: P1_INITIAL,
    // seed 在建表语句之后、同一个事务里执行：三行是三条不变量各自需要的锚点。
    // 1) persona_config：整库所有外键都指向 main，没有它就写不进任何业务数据；
    // 2) persona_state：self_view 有 NOT NULL，读取侧假定这一行一定存在（不写判空分支）；
    // 3) phase_state：阶段从 trust 起步 —— 「默认值」写在这里而不是表定义的 DEFAULT，
    //    是因为 since / updated_at 必须是建库那一刻的时间，不能靠 DEFAULT 猜。
    // 三行都用同一个 now：同一次建库的时间戳必须一致，否则「库是什么时候建的」会有三个答案。
    seed(db: MigrationSqlStore, now: string) {
      db.run(
        `INSERT INTO persona_config (persona_id, type, identity_path, persona_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['main', 'preset', 'identity.md', '{}', now, now],
      )
      db.run(
        `INSERT INTO persona_state (persona_id, self_view, revision, updated_at) VALUES (?, ?, ?, ?)`,
        ['main', '', 1, now],
      )
      db.run(
        `INSERT INTO phase_state (persona_id, phase, since, updated_at) VALUES (?, ?, ?, ?)`,
        ['main', 'trust', now, now],
      )
    },
  },
  {
    version: 2,
    name: 'growth-layer',
    sql: V2_GROWTH,
  },
  {
    version: 3,
    name: 'admission-observations',
    sql: V3_ADMISSION,
  },
  {
    version: 4,
    name: 'capture-key',
    sql: V4_CAPTURE_KEY,
  },
  {
    version: 5,
    name: 'capture-cursors',
    sql: V5_CAPTURE_CURSORS,
  },
  {
    version: 6,
    name: 'revision-disclosure',
    sql: V6_REVISION_DISCLOSURE,
  },
  {
    version: 7,
    name: 'disclosure-grants',
    sql: V7_DISCLOSURE_GRANTS,
  },
  {
    version: 8,
    name: 'grant-revocation',
    sql: V8_GRANT_REVOCATION,
  },
  {
    version: 9,
    name: 'disclosure-source',
    sql: V9_DISCLOSURE_SOURCE,
  },
  {
    version: 10,
    name: 'fts-rowids',
    sql: V10_FTS_ROWIDS,
  },
  {
    version: 11,
    name: 'recall-receipt',
    sql: V11_RECALL_RECEIPT,
  },
  {
    version: 12,
    name: 'quarantined-sources',
    sql: V12_QUARANTINED_SOURCES,
  },
  {
    version: 13,
    name: 'revision-derived-stats',
    sql: V13_REVISION_DERIVED_STATS,
  },
  {
    version: 14,
    name: 'recall-session-turn',
    sql: V14_RECALL_SESSION_TURN,
  },
  {
    version: 15,
    name: 'tensions',
    sql: V15_TENSIONS,
  },
  {
    version: 16,
    name: 'decisions',
    sql: V16_DECISIONS,
  },
  {
    version: 17,
    name: 'stance-key',
    sql: V17_STANCE_KEY,
  },
  {
    version: 18,
    name: 'diary',
    sql: V18_DIARY,
  },
  {
    version: 19,
    name: 'mood-meta',
    sql: V19_MOOD_META,
  },
  {
    version: 20,
    name: 'affect-history-append-only',
    sql: V20_AFFECT_HISTORY_APPEND_ONLY,
  },
  {
    version: 21,
    name: 'proactive-outbox',
    sql: V21_PROACTIVE_OUTBOX,
  },
  {
    version: 22,
    name: 'room-message-intake',
    sql: V22_ROOM_INTAKE,
  },
  { version: 23, name: 'group-scheduling', sql: V23_GROUP_SCHEDULING },
  { version: 24, name: 'qq-reply-outbox', sql: V24_QQ_REPLY_OUTBOX },
  { version: 25, name: 'growth-reflection', sql: V25_GROWTH_REFLECTION },
  { version: 26, name: 'growth-confirmation', sql: V26_GROWTH_CONFIRMATION },
  { version: 27, name: 'memory-hygiene', sql: V27_MEMORY_HYGIENE },
  { version: 28, name: 'external-source', sql: V28_EXTERNAL_SOURCE },
  { version: 29, name: 'growth-reflection-budget', sql: V29_GROWTH_REFLECTION_BUDGET },
  { version: 30, name: 'external-source-erase-events', sql: V30_EXTERNAL_SOURCE_ERASE },
  { version: 31, name: 'intention', sql: V31_INTENTION },
])

// 表数量自检：v1 三十一张 + v2 的 phase_milestones / learning_jobs + v3 的 admission_observations
// + v5 的 capture_cursors + v7 的 disclosure_grants + v11 的 recall_runs / recall_candidates
// + v12 的 quarantined_sources + v15 的 tension_versions + v16 的 decision_runs / decision_items
// + v18 的 diaries / diary_versions + v19 的 mood_meta + v21 的 proactive_outbox
// + v22 的 room_message_seq / room_participation_state
// + v23 的八张群调度/证明/回复操作记录表（正文仍复用 sources）
// + v24 的 qq_reply_outbox 私聊离线回复队列（正文只落这张表）
// + v25 的 growth_reflections / growth_candidates / growth_candidate_sources 成长反思候选
// + v27 的 memory_merge_events / memory_archive_events 记忆整理与淡忘事件
// + v28 的 external_sources / external_source_deletion_events 外界来源登记与删除事件
// + v29 的 growth_reflection_processed_sources 逐条 Source 已处理账本（另给 growth_reflections 加 source_ids 列）
// （v4/v6/v8/v9/v10/v13/v14/v17 只加列或只加索引，不加表；v18 另给 decision_runs 加 result_diary_id 列）。
// 自检用的是「新建一个空库后数 sqlite_master」这条路（adapter.tableCount），
// 所以这个常量是「结构断言」而不是「数据统计」：迁移里多建/少建一张表都会被它发现。
// 注意别把 FTS5 的影子表（fts_index_*）算进来，tableCount() 已经把它们排除了。
export const EXPECTED_TABLE_COUNT = 70

