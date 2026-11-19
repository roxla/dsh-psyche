// P2 Completion Batch 阶段 3：StanceEngine 的纯函数部分。
//
// 验收口径（设计冻结 docs/design/p2-stance-engine.md §2/§9）：
// - 只接受显式 group/direction，不从正文猜方向；
// - 四条门槛（belief 数、Tension、内部冲突、跨 belief 去重证据 + 跨会话）；
// - 正文模板确定性生成，同输入同输出；
// - 有既有身份时，只有 basis / evidence / statement 发生实质变化才 revise。
//
// 跑法：node test/stance-engine.ts（需要先 npm run build）
import {
  planStanceSynthesis,
  stanceKeyOf,
  STANCE_DIRECTION_LABELS,
  type StanceBeliefInput,
} from '../dist/lib/stance-engine.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function belief(overrides: Partial<StanceBeliefInput> = {}): StanceBeliefInput {
  return {
    artifactId: 'art_b1',
    revision: 1,
    state: 'active',
    statement: '用户喜欢乌龙茶。',
    confidence: 'medium',
    updatedAt: '2026-11-09T10:00:00.000Z',
    group: 'topic:tea',
    direction: 'for',
    evidenceKeys: ['ind_1'],
    sessionRefs: ['session-a'],
    ...overrides,
  }
}

console.log('\n[Stance Engine] 身份键与门槛')

ok('身份键是 group:direction', stanceKeyOf('topic:tea', 'for') === 'topic:tea:for', stanceKeyOf('topic:tea', 'for'))
ok('方向标签齐全', STANCE_DIRECTION_LABELS.for === '倾向肯定' && STANCE_DIRECTION_LABELS.against === '倾向否定', STANCE_DIRECTION_LABELS)

const onlyOne = planStanceSynthesis({ beliefs: [belief()], existing: null })
ok('只有一条 belief → skip insufficient-beliefs', onlyOne.action === 'skip' && onlyOne.reason === 'insufficient-beliefs', onlyOne)

const inactiveIgnored = planStanceSynthesis({
  beliefs: [belief(), belief({ artifactId: 'art_b2', state: 'challenged' as never })],
  existing: null,
})
ok('challenged 不参与合成 → 仍只有一条有效', inactiveIgnored.action === 'skip' && inactiveIgnored.reason === 'insufficient-beliefs', inactiveIgnored)

const tension = planStanceSynthesis({
  beliefs: [belief(), belief({ artifactId: 'art_b2', evidenceKeys: ['ind_2'], sessionRefs: ['session-b'] })],
  existing: null,
  unresolvedTensionArtifacts: new Set(['art_b1']),
})
ok('组内有未解决 Tension → skip unresolved-tension', tension.action === 'skip' && tension.reason === 'unresolved-tension', tension)

const conflict = planStanceSynthesis({
  beliefs: [belief(), belief({ artifactId: 'art_b2', evidenceKeys: ['ind_2'], sessionRefs: ['session-b'] })],
  existing: null,
  conflicts: new Set(['art_b2']),
})
ok('belief 之间有 contradicts → skip internal-conflict', conflict.action === 'skip' && conflict.reason === 'internal-conflict', conflict)

const duplicateEvidence = planStanceSynthesis({
  beliefs: [belief(), belief({ artifactId: 'art_b2', evidenceKeys: ['ind_1'], sessionRefs: ['session-b'] })],
  existing: null,
})
ok('跨 belief 证据去重后只有 1 条 → insufficient-evidence', duplicateEvidence.action === 'skip' && duplicateEvidence.reason === 'insufficient-evidence', duplicateEvidence)

const singleSession = planStanceSynthesis({
  beliefs: [belief(), belief({ artifactId: 'art_b2', evidenceKeys: ['ind_2'], sessionRefs: ['session-a'] })],
  existing: null,
})
ok('只在一个会话出现 → insufficient-evidence', singleSession.action === 'skip' && singleSession.reason === 'insufficient-evidence', singleSession)

console.log('\n[Stance Engine] 合成与修订')

const two = [
  belief({ artifactId: 'art_b1', evidenceKeys: ['ind_1'], sessionRefs: ['session-a'], confidence: 'medium' }),
  belief({
    artifactId: 'art_b2',
    revision: 2,
    statement: '用户明确说过喜欢乌龙茶的清香。',
    confidence: 'high',
    updatedAt: '2026-11-09T11:00:00.000Z',
    evidenceKeys: ['ind_2'],
    sessionRefs: ['session-b'],
  }),
]
const created = planStanceSynthesis({ beliefs: two, existing: null })
ok('两条达标 belief → create', created.action === 'create', created)
if (created.action === 'create') {
  ok('身份键正确', created.key === 'topic:tea:for', created.key)
  ok('正文用模板 + 置信度最高的那条', created.statement === '关于 topic:tea，倾向肯定：用户明确说过喜欢乌龙茶的清香。', created.statement)
  ok('basis 精确到 revision 且按 id 排序', JSON.stringify(created.basis) === JSON.stringify([
    { artifactId: 'art_b1', revision: 1 },
    { artifactId: 'art_b2', revision: 2 },
  ]), created.basis)
  ok('证据是跨 belief 去重的并集', JSON.stringify(created.evidenceKeys) === JSON.stringify(['ind_1', 'ind_2']), created.evidenceKeys)
  ok('会话数是并集', created.sessionCount === 2, created.sessionCount)
}

const again = planStanceSynthesis({ beliefs: [...two].reverse(), existing: null })
ok('同输入（换顺序）同输出 → 确定性', JSON.stringify(again) === JSON.stringify(created), again)

const existing = created.action === 'create'
  ? {
      statement: created.statement,
      state: 'active' as const,
      basis: created.basis,
      evidenceKeys: created.evidenceKeys,
    }
  : null
const unchanged = planStanceSynthesis({ beliefs: two, existing })
ok('没有实质变化 → skip no-change', unchanged.action === 'skip' && unchanged.reason === 'no-change', unchanged)

const basisChanged = planStanceSynthesis({
  beliefs: [
    two[0]!,
    { ...two[1]!, revision: 3, statement: '用户明确说过喜欢乌龙茶的清香。', updatedAt: '2026-11-09T12:00:00.000Z' },
  ],
  existing,
})
ok('basis 版本变化 → revise basis', basisChanged.action === 'revise' && basisChanged.changedBecause === 'basis', basisChanged)

const evidenceChanged = planStanceSynthesis({
  beliefs: [two[0]!, { ...two[1]!, evidenceKeys: ['ind_2', 'ind_3'] }],
  existing,
})
ok('证据增加 → revise evidence', evidenceChanged.action === 'revise' && evidenceChanged.changedBecause === 'evidence', evidenceChanged)

const statementChanged = planStanceSynthesis({
  beliefs: [two[0]!, { ...two[1]!, statement: '用户喜欢乌龙茶的回甘。', confidence: 'high', updatedAt: '2026-11-09T13:00:00.000Z' }],
  existing,
})
ok('代表句变化 → revise statement', statementChanged.action === 'revise' && statementChanged.changedBecause === 'statement', statementChanged)

console.log(`\n[Stance Engine] ${passed} 通过 ${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
