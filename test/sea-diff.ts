import { classifyDiff, fingerprint, shouldReset } from '../dist/lib/sea-diff.js'

let pass = 0
let fail = 0

function ok(name: string, condition: boolean): void {
  if (condition) {
    pass += 1
    console.log(`ok ${pass} - ${name}`)
  } else {
    fail += 1
    console.error(`not ok ${pass + fail} - ${name}`)
  }
}

const prev = { at: '2026-11-10T00:00:00.000Z', fingerprint: '10:20:2026-11-10T00:00:00.000Z', instanceKey: 'abc123' }

ok('first visit has no diff', classifyDiff(null, { createdAt: '2026-11-11T00:00:00.000Z', revisedAt: null }) === null)
ok('created after visit is new', classifyDiff(prev, { createdAt: '2026-11-11T00:00:00.000Z', revisedAt: null }) === 'new')
ok('revised after visit is updated', classifyDiff(prev, { createdAt: '2026-11-01T00:00:00.000Z', revisedAt: '2026-11-11T00:00:00.000Z' }) === 'updated')
ok('new wins over updated', classifyDiff(prev, { createdAt: '2026-11-11T00:00:00.000Z', revisedAt: '2026-11-12T00:00:00.000Z' }) === 'new')
ok('old node has no diff', classifyDiff(prev, { createdAt: '2026-11-01T00:00:00.000Z', revisedAt: '2026-11-02T00:00:00.000Z' }) === null)
ok('invalid timestamps never mark', classifyDiff(prev, { createdAt: 'not-a-date', revisedAt: 'still-not' }) === null)

const scene = {
  instanceKey: 'abc123',
  diffAvailable: true,
  stats: { totalArtifacts: 10, totalEvents: 20, span: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z' } },
}
ok('fingerprint uses totals and window end', fingerprint(scene as any) === '10:20:2026-11-10T00:00:00.000Z')
ok('same instance and valid fingerprint does not reset', shouldReset(prev, scene as any) === false)
ok('different instance resets', shouldReset(prev, { ...scene, instanceKey: 'def456' } as any) === true)
ok('unavailable diff resets', shouldReset(prev, { ...scene, diffAvailable: false } as any) === true)
ok('malformed fingerprint resets', shouldReset({ ...prev, fingerprint: 'broken' }, scene as any) === true)

console.log(`${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
