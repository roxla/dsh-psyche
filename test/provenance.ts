/**
 * 来源分类自检（`src/lib/provenance.ts`）。
 *
 * 为什么单独测：来源分类是**显示给用户看的标签**，一旦判错，
 * 用户会以为「我自己推的」是「你告诉我的」——那是把没有依据的结论冒充成别人的话。
 * 这里把五类的判据、优先级、未知 origin 的处理全部钉死。
 * 跑法：`node test/provenance.ts`（要求先 `npm run build`）。
 */
import { PROVENANCE_KINDS, PROVENANCE_LABELS, provenanceLine, provenanceOf } from '../dist/lib/provenance.js'
import type { ProvenanceSourceInput } from '../dist/lib/provenance.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

/** 一条来源的构造器：只写关心的字段，其余留空，避免测试里一堆 null。 */
function source(overrides: Partial<ProvenanceSourceInput> & { origin: string }): ProvenanceSourceInput {
  return { kind: null, provider: null, canonicalUrl: null, workspaceRef: null, contentHash: null, ...overrides }
}

function main(): void {
  console.log('来源分类自检')

  // ---- 五类都认得出来 ----
  check('五类顺序固定', PROVENANCE_KINDS.join(',') === 'confirmed,user-stated,observed,synthesized,inferred', PROVENANCE_KINDS)
  check('每类都有中文名', PROVENANCE_KINDS.every((kind) => Boolean(PROVENANCE_LABELS[kind])), PROVENANCE_LABELS)

  const confirmed = provenanceOf({ sources: [source({ origin: 'self', kind: 'model' })], confirmedByHuman: true })
  check('人确认过 → confirmed', confirmed.kind === 'confirmed', confirmed.kind)
  check('confirmed 的标签是「人确认过」', confirmed.label === '人确认过', confirmed.label)

  const stated = provenanceOf({ sources: [source({ origin: 'user', kind: 'user' })] })
  check('用户来源 → user-stated', stated.kind === 'user-stated', stated.kind)
  check('user-stated 的理由含条数', (stated.reasons[0] ?? '').includes('1 条用户来源'), stated.reasons)

  const observed = provenanceOf({
    sources: [source({ origin: 'external', kind: 'web', provider: 'bing', canonicalUrl: 'https://example.com/a' })],
  })
  check('外部来源 → observed', observed.kind === 'observed', observed.kind)
  check('外部来源有痕迹 → hasTraceableExternal', observed.hasTraceableExternal === true)
  check('observed 的理由点名痕迹类型', (observed.reasons[1] ?? '').includes('网页'), observed.reasons)

  const synthesized = provenanceOf({ sources: [source({ origin: 'self', kind: 'model' })], lineage: ['derivedFrom'] })
  check('只有自身来源 + 有血缘 → synthesized', synthesized.kind === 'synthesized', synthesized.kind)
  check('synthesized 的理由点名血缘关系', (synthesized.reasons[0] ?? '').includes('derivedFrom'), synthesized.reasons)

  const inferred = provenanceOf({ sources: [source({ origin: 'self', kind: 'model' })] })
  check('只有自身来源 + 无血缘 → inferred', inferred.kind === 'inferred', inferred.kind)
  const empty = provenanceOf({ sources: [] })
  check('没有来源记录也算 inferred（不是未知）', empty.kind === 'inferred' && empty.counts.total === 0, empty.counts)

  // ---- 优先级：顺序就是判据 ----
  const userAndExternal = provenanceOf({
    sources: [source({ origin: 'user' }), source({ origin: 'external', canonicalUrl: 'https://example.com/b' })],
  })
  check('用户来源 + 外部来源 → user-stated（先问是谁说的）', userAndExternal.kind === 'user-stated', userAndExternal.kind)
  const confirmedWins = provenanceOf({ sources: [source({ origin: 'user' })], confirmedByHuman: true })
  check('确认过就压过一切', confirmedWins.kind === 'confirmed', confirmedWins.kind)
  const lineageWithUser = provenanceOf({ sources: [source({ origin: 'user' })], lineage: ['derivedFrom'] })
  check('有用户来源时血缘不抢戏 → user-stated', lineageWithUser.kind === 'user-stated', lineageWithUser.kind)
  const lineageWithExternal = provenanceOf({ sources: [source({ origin: 'external', provider: 'rss' })], lineage: ['splitFrom'] })
  check('有外部来源时血缘不抢戏 → observed', lineageWithExternal.kind === 'observed', lineageWithExternal.kind)

  // ---- 边界：未知 origin、无痕迹外部来源、无关血缘 ----
  const unknownOrigin = provenanceOf({ sources: [source({ origin: 'robot' })] })
  check('未知 origin 按自身来源处理', unknownOrigin.counts.self === 1 && unknownOrigin.counts.user === 0, unknownOrigin.counts)
  check('未知 origin 不会被冒充成用户来源', unknownOrigin.kind !== 'user-stated', unknownOrigin.kind)

  const bareExternal = provenanceOf({ sources: [source({ origin: 'external', kind: 'web' })] })
  check('外部来源没痕迹仍是 observed', bareExternal.kind === 'observed', bareExternal.kind)
  check('没痕迹时 hasTraceableExternal=false', bareExternal.hasTraceableExternal === false)
  check('没痕迹时说明「核不回去」', bareExternal.reasons.some((line) => line.includes('核不回去')), bareExternal.reasons)

  const unrelatedLineage = provenanceOf({ sources: [source({ origin: 'self' })], lineage: ['supersedes', 'revisedFrom'] })
  check('非合成类血缘不算 synthesized', unrelatedLineage.kind === 'inferred' && unrelatedLineage.lineageRelations.length === 0, unrelatedLineage.lineageRelations)

  const duplicatedLineage = provenanceOf({ sources: [source({ origin: 'self' })], lineage: ['derivedFrom', 'derivedFrom', '  '] })
  check('血缘去重且忽略空值', duplicatedLineage.lineageRelations.length === 1, duplicatedLineage.lineageRelations)

  // ---- 计数与渲染行 ----
  const mixed = provenanceOf({
    sources: [
      source({ origin: 'user' }),
      source({ origin: 'external', workspaceRef: 'D:/a.md' }),
      source({ origin: 'external', contentHash: 'abc' }),
      source({ origin: 'self' }),
      source({ origin: 'self' }),
    ],
  })
  check('计数正确', mixed.counts.user === 1 && mixed.counts.external === 2 && mixed.counts.self === 2 && mixed.counts.total === 5, mixed.counts)
  check('可核验痕迹计数正确', mixed.counts.traceable === 2, mixed.counts)
  check('渲染行形如「标签（依据）」', provenanceLine(mixed) === '你告诉我的（1 条用户来源）', provenanceLine(mixed))
  check('渲染行不会出现空括号', provenanceLine(provenanceOf({ sources: [] })) === '我自己推的（没有任何来源记录）', provenanceLine(empty))

  // ---- 红线条：来源分类不携带可信度分数 ----
  check('结果里没有 trust / score / confidence 字段', ['trust', 'score', 'confidence', 'rank'].every((key) => !(key in mixed)), Object.keys(mixed))

  console.log(`\n来源分类自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main()
