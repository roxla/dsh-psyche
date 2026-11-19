import {
  MOOD_BEHAVIOR_VERSION,
  MoodBehaviorState,
  MoodTurnClock,
  affectScore,
  computeMoodBehavior,
  moodScore,
  moodStateKey,
  renderMoodProjection,
} from '../dist/lib/mood-behavior.js'
import { defaultMoodValues } from 'dsh-psyche-core'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean): void {
  if (condition) passed += 1
  else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}
function eq<T>(label: string, actual: T, expected: T): void {
  const good = Object.is(actual, expected)
  if (!good) console.error(`  ✗ ${label}: ${String(actual)} !== ${String(expected)}`)
  ok(label, good)
}
function near(label: string, actual: number, expected: number, epsilon = 1e-9): void {
  const good = Math.abs(actual - expected) <= epsilon
  if (!good) console.error(`  ✗ ${label}: ${actual} vs ${expected}`)
  ok(label, good)
}

console.log('[P5-4 mood-behavior]')

// 1. 全 baseline → 0
const base = defaultMoodValues()
near('baseline score 0', moodScore(base), 0)

// 2. 正向/负向维度方向
const highHappy = { ...base, happy: 100 }
ok('happy high → positive', moodScore(highHappy) > 0)
const highDown = { ...base, down: 100 }
ok('down high → negative', moodScore(highDown) < 0)
const highCalm = { ...base, calm: 100 }
ok('calm high → positive', moodScore(highCalm) > 0)

// 3. 层权：contemporary 强于 basic
const highHook = { ...base, hooked: 100 }
ok('contemporary weighs more than basic', Math.abs(moodScore(highHook)) > Math.abs(moodScore(highHappy)))

// 4. 同层 top2：两个强维比一个更强
const twoStrong = { ...base, happy: 100, excited: 100 }
ok('top2 aggregation > single', moodScore(twoStrong) > moodScore(highHappy))

// 5. 负向维度公式：baseline 为 10 的 irritated 升高应产生负贡献，且不因 baseline 小而除零
const highIrritated = { ...base, irritated: 100 }
ok('irritated high → negative', moodScore(highIrritated) < 0)

// 6. Affect 符号与权重
near('affect empty 0', affectScore(null), 0)
const warm = affectScore({ warmth: 100 })
const hurt = affectScore({ hurt: 100 })
ok('warmth positive', warm > 0)
ok('hurt negative', hurt < 0)
ok('warmth outweighs hurt weight', warm > Math.abs(hurt))
near('missing weight 0', affectScore({ missing: 100 }), 0)

// 7. 总 score 权重
const mixed = computeMoodBehavior({ mood: highHappy, affect: { hurt: 100 } }, new MoodBehaviorState())
near('0.75/0.25 composition', mixed.score, 0.75 * moodScore(highHappy) + 0.25 * affectScore({ hurt: 100 }))

// 8. 档位阈值
const expressiveState = new MoodBehaviorState()
eq('enter expressive at >=0.35', expressiveState.decide(0.35, 1).band, 'expressive')
eq('expressive stays at 0.26', expressiveState.decide(0.26, 2).band, 'expressive')
eq('expressive exits at <=0.25', expressiveState.decide(0.25, 3).band, 'balanced')
const reservedState = new MoodBehaviorState()
eq('enter reserved at <=-0.35', reservedState.decide(-0.35, 1).band, 'reserved')
eq('reserved stays at -0.26', reservedState.decide(-0.26, 2).band, 'reserved')
eq('reserved exits at >=-0.25', reservedState.decide(-0.25, 3).band, 'balanced')

// 9. 同 Turn 不推进、Turn+1 才推进、Turn 回退不推进
const dwell = new MoodBehaviorState()
eq('turn1 expressive', dwell.decide(0.5, 1).band, 'expressive')
eq('same turn stays expressive', dwell.decide(-0.9, 1).band, 'expressive')
eq('turn2 crosses one step to balanced', dwell.decide(-0.9, 2).band, 'balanced')
eq('turn1 rollback no change', dwell.decide(0.9, 1).band, 'balanced')

// 10. 无可信 Turn → balanced
const unknownTurn = new MoodBehaviorState()
eq('unknown turn balanced', unknownTurn.decide(0.9, null).band, 'balanced')

// 11. 渲染：单出口、无数字、≤120
const line = renderMoodProjection('reserved', '轻快 12')
ok('render length <=120', line.length <= 120)
ok('render excludes digits', !/[0-9]/.test(line))
ok('render contains band phrase', line.includes('克制'))
ok('render includes tone only as supplement', line.includes('轻快'))

// 12. 状态隔离
const a = new MoodBehaviorState()
const b = new MoodBehaviorState()
a.decide(0.9, 1)
eq('state isolation', b.decide(0.9, 2).band, 'expressive')
eq('version stable', MOOD_BEHAVIOR_VERSION, 'mood-behavior-v1')

// 13. Host Turn 时钟：单调记录、重复/回退不推进、按 agent|session 隔离
const clock = new MoodTurnClock()
const agentRef = { id: 'agent-a', session: { id: 'session-1' } }
clock.record(agentRef, 5)
eq('clock reads last turn', clock.get(agentRef), 5)
clock.record(agentRef, 3)
eq('clock ignores backwards turn', clock.get(agentRef), 5)
clock.record(agentRef, 5)
eq('clock ignores duplicate turn', clock.get(agentRef), 5)
clock.record({ id: 'agent-b', session: { id: 'session-2' } }, 1)
eq('clock isolates by agent|session', clock.get({ id: 'agent-b', session: { id: 'session-2' } }), 1)
eq('clock unknown agent null', clock.get({ id: 'nobody' }), null)
eq('moodStateKey empty null', moodStateKey({}), null)
clock.record({ id: 'agent-c' }, 9)
eq('clock key without session', clock.get({ id: 'agent-c' }), 9)
clock.clear()
eq('clock clears on unload', clock.get(agentRef), null)

console.log(`[P5-4 mood-behavior] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
