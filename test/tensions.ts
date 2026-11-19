/**
 * 张力管理自检（`src/lib/tensions.ts`）。
 *
 * 为什么单独测：状态机与自动探测都是纯函数，出错不会在别处暴露——
 * 一旦状态机放过一条非法转移，矛盾就会被静默「解决」；一旦探测阈值写松，面板会被假矛盾灌满。
 * 这里把判据、边界与「不值得自动报」的情形都钉死。
 * 跑法：`node test/tensions.ts`（要求先 `npm run build`）。
 */
import {
  TENSION_ALGORITHM_VERSION,
  TENSION_TRANSITIONS,
  assertTransition,
  canTransition,
  detectTensions,
  pairKeyOf,
  polarityOf,
  resolutionOfVerdict,
  severityOf,
  similarityOf,
} from '../dist/lib/tensions.js'
import type { TensionCandidateItem } from '../dist/lib/tensions.js'

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

/** 期望某段代码抛错，并核对错误码：状态机拒绝必须给对码，不能抛个 TypeError 也算过。 */
function expectError(fn: () => unknown, code: string): { ok: boolean; message: string } {
  try {
    fn()
    return { ok: false, message: '没有抛错' }
  } catch (error) {
    const actual = (error as { code?: string }).code
    return { ok: actual === code, message: String((error as Error).message) }
  }
}

function side(overrides: Partial<TensionCandidateItem> & { artifactId: string; statement: string }): TensionCandidateItem {
  return {
    revision: 1,
    kind: 'fact',
    state: 'active',
    subjectRefs: ['topic:cat'],
    ...overrides,
  }
}

function main(): void {
  console.log('张力管理自检')

  // ---- pairKey：顺序无关、版本敏感 ----
  const a = { artifactId: 'art_a', revision: 1 }
  const b = { artifactId: 'art_b', revision: 2 }
  check('pairKey 与调用顺序无关', pairKeyOf(a, b) === pairKeyOf(b, a))
  check('pairKey 形如 id#rev|id#rev', pairKeyOf(a, b) === 'art_a#1|art_b#2', pairKeyOf(a, b))
  check('pairKey 区分版本', pairKeyOf(a, b) !== pairKeyOf({ ...a, revision: 2 }, b))

  // ---- polarity：否定识别与固定搭配 ----
  const neg = polarityOf('她不喜欢猫')
  check('「不喜欢」判为否定', neg.negated === true, neg)
  check('剥掉否定词后还原为「她喜欢猫」', neg.stripped === '她喜欢猫', neg.stripped)
  check('命中的否定标记可解释', neg.markers.includes('不'), neg.markers)
  check('「她喜欢猫」不是否定', polarityOf('她喜欢猫').negated === false)
  check('「这个主意不错」不算否定（固定搭配）', polarityOf('这个主意不错').negated === false)
  check('「我不得不去」不算否定（固定搭配）', polarityOf('我不得不去').negated === false)
  check('「没有去过」判为否定', polarityOf('没有去过').negated === true)

  // ---- similarity ----
  check('同一句话相似度为 1', similarityOf('她喜欢猫', '她喜欢猫') === 1)
  check('毫不相干的两句相似度为 0', similarityOf('她喜欢猫', '天气很好') === 0)
  check('空文本相似度为 0', similarityOf('', '她喜欢猫') === 0)

  // ---- 自动探测：真的矛盾要报 ----
  const contradictory = detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她不喜欢猫' })])
  check('同话题 + 否定相反 → 报一条矛盾', contradictory.length === 1, contradictory)
  check('类型是 contradiction', contradictory[0]?.kind === 'contradiction')
  check('依据里带相似度与否定标记', (contradictory[0]?.basis.similarity ?? 0) >= 0.99 && (contradictory[0]?.basis.negationMarkers.length ?? 0) > 0, contradictory[0]?.basis)
  check('依据里带算法版本', contradictory[0]?.basis.algorithmVersion === TENSION_ALGORITHM_VERSION)
  check('依据里带共享话题', contradictory[0]?.basis.sharedSubjects.includes('topic:cat') === true, contradictory[0]?.basis.sharedSubjects)

  // ---- 自动探测：不该报的都不报 ----
  check('否定性相同不报（都是肯定）', detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她喜欢狗' })]).length === 0)
  check('否定性相同不报（都是否定）', detectTensions([side({ artifactId: 'art_a', statement: '她不喜欢猫' }), side({ artifactId: 'art_b', statement: '她不喜欢狗' })]).length === 0)
  check(
    '话题不重合不报',
    detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她不喜欢猫', subjectRefs: ['topic:dog'] })]).length === 0,
  )
  check(
    '话题为空不报（没有锚点就不判同一件事）',
    detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫', subjectRefs: [] }), side({ artifactId: 'art_b', statement: '她不喜欢猫', subjectRefs: [] })]).length === 0,
  )
  check(
    '同话题但措辞差太远不报',
    detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她并不是那种会把猫抱回家的人' })]).length === 0,
  )
  check(
    '反义词不在自动探测范围（喜欢/讨厌）',
    detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她讨厌猫' })]).length === 0,
  )
  check(
    '同一 artifact 的两个版本不和自己打架',
    detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_a', revision: 2, statement: '她不喜欢猫' })]).length === 0,
  )
  check(
    '已登记过的 pair 会跳过',
    detectTensions([side({ artifactId: 'art_a', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她不喜欢猫' })], {
      existingPairKeys: ['art_a#1|art_b#1'],
    }).length === 0,
  )

  // ---- 自动探测：类型/状态过滤与上限 ----
  check(
    'relationship 不参与自动探测',
    detectTensions([side({ artifactId: 'art_a', kind: 'relationship', statement: '她是朋友' }), side({ artifactId: 'art_b', kind: 'relationship', statement: '她不是朋友' })]).length === 0,
  )
  check(
    'retracted 版本不再参与探测',
    detectTensions([side({ artifactId: 'art_a', state: 'retracted', statement: '她喜欢猫' }), side({ artifactId: 'art_b', statement: '她不喜欢猫' })]).length === 0,
  )
  const many = detectTensions(
    [
      side({ artifactId: 'art_a1', statement: '她喜欢猫' }),
      side({ artifactId: 'art_b1', statement: '她不喜欢猫' }),
      side({ artifactId: 'art_a2', statement: '她喜欢狗' }),
      side({ artifactId: 'art_b2', statement: '她不喜欢狗' }),
    ],
    { maxPairs: 1 },
  )
  check('上限生效（只给一对）', many.length === 1, many.length)
  const ordered = detectTensions([
    side({ artifactId: 'art_b', statement: '她不喜欢猫' }),
    side({ artifactId: 'art_a', statement: '她喜欢猫' }),
    side({ artifactId: 'art_d', statement: '他喜欢跑步', subjectRefs: ['topic:run'] }),
    side({ artifactId: 'art_c', statement: '他不喜欢跑步', subjectRefs: ['topic:run'] }),
  ])
  check('输出按 pairKey 排序（确定性）', ordered.length === 2 && ordered[0]!.pairKey < ordered[1]!.pairKey, ordered.map((item) => item.pairKey))

  // ---- 状态机：四态 + 终态（批次 A1 扩表） ----
  check('open 可以转 resolved', canTransition('open', 'resolved'))
  check('open 可以转 withdrawn', canTransition('open', 'withdrawn'))
  check('open 可以转 investigating（有新证据才能查）', canTransition('open', 'investigating'))
  check('investigating 可以搁置', canTransition('investigating', 'parked'))
  check('investigating 可以回到 open（放弃调查）', canTransition('investigating', 'open'))
  check('parked 可以被新证据唤醒', canTransition('parked', 'investigating'))
  check('resolved 可以回到 open（再次出现）', canTransition('resolved', 'open'))
  check('withdrawn 是终态', ['open', 'investigating', 'parked', 'resolved'].every((to) => canTransition('withdrawn', to as never) === false))
  check('同状态不能自转', canTransition('open', 'open') === false)
  check('状态机共有十条边', Object.values(TENSION_TRANSITIONS).reduce((sum, list) => sum + list.length, 0) === 10, Object.values(TENSION_TRANSITIONS).map((list) => list.length))
  check('没查过就搁置被拒（open→parked）', canTransition('open', 'parked') === false)
  check('搁置中不能直接判解决（parked→resolved）', canTransition('parked', 'resolved') === false)

  const okResolve = assertTransition('open', 'resolved', { note: '已由 revise 改口' })
  check('合法转移返回 reopened=false', okResolve.reopened === false)
  check('解决没写依据 → E_STATE', expectError(() => assertTransition('open', 'resolved'), 'E_STATE').ok)
  check('作废没写原因 → E_STATE', expectError(() => assertTransition('open', 'withdrawn'), 'E_STATE').ok)
  check('同状态写回 → E_STATE', expectError(() => assertTransition('open', 'open'), 'E_STATE').ok)
  check('withdrawn→open 被拒且给出理由', expectError(() => assertTransition('withdrawn', 'open', { eventId: 'evt_x', note: 'y' }), 'E_STATE').message.includes('不复活'))
  check('再次出现没带事件 → E_STATE', expectError(() => assertTransition('resolved', 'open', { note: '又矛盾了' }), 'E_STATE').ok)
  const reopened = assertTransition('resolved', 'open', { eventId: 'evt_new', note: '新反证' })
  check('再次出现带事件 → 合法且 reopened=true', reopened.reopened === true)

  // ---- 状态机：新增必填材料（批次 A3 异常矩阵） ----
  check('进「在查」不带证据 → E_STATE', expectError(() => assertTransition('open', 'investigating'), 'E_STATE').ok)
  check('进「在查」带空数组 → E_STATE', expectError(() => assertTransition('open', 'investigating', { sourceIds: ['  '] }), 'E_STATE').ok)
  const investigating = assertTransition('open', 'investigating', { sourceIds: ['src_a'] })
  check('进「在查」带来源 → 合法', investigating.to === 'investigating' && investigating.reopened === false)
  check('搁置不写原因 → E_STATE', expectError(() => assertTransition('investigating', 'parked'), 'E_STATE').ok)
  check('搁置写原因 → 合法', assertTransition('investigating', 'parked', { note: '先看这周她怎么说' }).to === 'parked')
  check('唤醒搁置不带证据 → E_STATE', expectError(() => assertTransition('parked', 'investigating', { note: '又想起来了' }), 'E_STATE').ok)
  check('唤醒搁置带证据 → 合法', assertTransition('parked', 'investigating', { sourceIds: ['src_b'] }).to === 'investigating')
  check('放弃调查不写原因 → E_STATE', expectError(() => assertTransition('investigating', 'open'), 'E_STATE').ok)
  check('搁置中作废（误报）→ 合法但要原因', expectError(() => assertTransition('parked', 'withdrawn'), 'E_STATE').ok && assertTransition('parked', 'withdrawn', { note: '重复登记' }).to === 'withdrawn')
  check('在查中作废 → 需要原因', expectError(() => assertTransition('investigating', 'withdrawn'), 'E_STATE').ok)
  check('在查中判解决 → 需要依据', expectError(() => assertTransition('investigating', 'resolved'), 'E_STATE').ok)
  check('在查中判解决带依据 → 合法', assertTransition('investigating', 'resolved', { note: '新证据推翻了左边' }).to === 'resolved')

  // ---- 严重度只用于排序 ----
  check('高相似 + 两侧活着 → high', severityOf({ left: { state: 'active' }, right: { state: 'active' }, basis: { sharedSubjects: ['t'], similarity: 0.95 } }) === 'high')
  check('中等相似 → medium', severityOf({ left: { state: 'active' }, right: { state: 'challenged' }, basis: { sharedSubjects: ['t'], similarity: 0.7 } }) === 'medium')
  check('一侧已死 → low', severityOf({ left: { state: 'retracted' }, right: { state: 'active' }, basis: { sharedSubjects: ['t'], similarity: 0.99 } }) === 'low')

  // ---- 解决方式映射 ----
  check('review(revised) → revised', resolutionOfVerdict('revised') === 'revised')
  check('review(rejected) → rejected', resolutionOfVerdict('rejected') === 'rejected')
  check('review(confirmed) 不构成裁决', resolutionOfVerdict('confirmed') === null)
  check('review(refined) 不构成裁决', resolutionOfVerdict('refined') === null)

  console.log(`\n张力管理自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main()
