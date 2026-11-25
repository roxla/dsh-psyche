/**
 * 第二批：允许回复时段的存储契约（GPT 第 1 轮 ① 的行为锁）。
 *
 * 锁的是「跨组保留」：保存时段之后再去改访问名单或默认模型（含清除），
 * 时段规则与其它对象必须原样还在；反过来，删掉一条时段也不能把名单/模型带走。
 * 只测覆盖层本身——HTTP 层与 UI 层的锁在 qq-control-center 的套件里。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QqOverlayValidationError,
  QqSettingsOverlay,
  type QqReplyRule,
} from '../dist/lib/qq-settings-overlay.js'

let passed = 0
let failed = 0

const ok = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed += 1
    console.log(`ok ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name} -> ${JSON.stringify(detail)}`)
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-reply-store-'))
const file = join(dir, 'qq-overrides.json')
const overlay = new QqSettingsOverlay({ file })

const windowsRule: QqReplyRule = {
  mode: 'windows',
  timeZone: 'Asia/Shanghai',
  windows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 }],
}
const pausedRule: QqReplyRule = { mode: 'paused' }

try {
  // A：两条时段写入，revision 依次增长
  const rev1 = await overlay.saveReplyRule({ kind: 'private', id: '10001' }, windowsRule, 0)
  const rev2 = await overlay.saveReplyRule({ kind: 'group', id: '20002' }, pausedRule, rev1)
  let raw = overlay.read()
  ok('A1 私聊时段写入成功', rev1 === 1 && raw.replySchedules?.['private:10001']?.mode === 'windows', { rev1, raw })
  ok('A2 群时段与私聊时段并存', rev2 === 2 && Object.keys(raw.replySchedules ?? {}).sort().join(',') === 'group:20002,private:10001', raw.replySchedules)

  // B：改访问名单不能带走时段
  const rev3 = await overlay.saveAccess({ owner: '695115698', extra: ['3320044'], groups: ['30001'] }, rev2)
  raw = overlay.read()
  const bSchedules = raw.replySchedules ?? {}
  ok('B1 保存名单后 revision 前进', rev3 === 3, rev3)
  ok('B2 保存名单后两条时段原样保留', bSchedules['private:10001']?.mode === 'windows' && bSchedules['group:20002']?.mode === 'paused', bSchedules)
  ok('B3 保存名单后名单本身生效', raw.access?.owner === '695115698' && raw.access?.groups.join(',') === '30001', raw.access)

  // C：清除访问名单也不能带走时段
  const rev4 = await overlay.clearAccess(rev3)
  raw = overlay.read()
  const cSchedules = raw.replySchedules ?? {}
  ok('C1 清除名单后 revision 前进', rev4 === 4 && raw.access === undefined, { rev4, access: raw.access })
  ok('C2 清除名单后两条时段原样保留', Object.keys(cSchedules).sort().join(',') === 'group:20002,private:10001', cSchedules)

  // D：改/清默认模型也不能带走时段
  const rev5 = await overlay.saveModelSelection({ provider: 'p', model: 'm' }, rev4)
  raw = overlay.read()
  ok('D1 保存模型后时段保留', rev5 === 5 && Object.keys(raw.replySchedules ?? {}).length === 2, { rev5, raw })
  const rev6 = await overlay.clearModelSelection(rev5)
  raw = overlay.read()
  ok('D2 清除模型后时段保留', rev6 === 6 && Object.keys(raw.replySchedules ?? {}).length === 2, { rev6, raw })

  // E：删一条只影响那一条
  const rev7 = await overlay.saveReplyRule({ kind: 'private', id: '10001' }, null, rev6)
  raw = overlay.read()
  ok('E1 删除私聊时段后只剩群时段', rev7 === 7 && Object.keys(raw.replySchedules ?? {}).join(',') === 'group:20002', raw.replySchedules)
  ok('E2 删除一条不影响名单/模型（本来就没有）', raw.access === undefined && raw.modelSelection === undefined, raw)

  // F：非法规则整次拒写，revision 与文件都不变
  const before = overlay.read().revision
  let thrown: unknown = null
  try {
    await overlay.saveReplyRule({ kind: 'group', id: '20002' }, { mode: 'windows', timeZone: 'Asia/Shanghai', windows: [] }, before)
  } catch (error) {
    thrown = error
  }
  ok('F1 空时段被拒且是校验错误', thrown instanceof QqOverlayValidationError, thrown instanceof Error ? thrown.message : thrown)
  ok('F2 非法写入不推进 revision', overlay.read().revision === before, { before, after: overlay.read().revision })

  // G：最后一条删掉后整组消失，不留空对象
  const rev8 = await overlay.saveReplyRule({ kind: 'group', id: '20002' }, null, before)
  raw = overlay.read()
  ok('G1 删空后 replySchedules 整组移除', rev8 === before + 1 && raw.replySchedules === undefined, { rev8, raw })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`${passed} 通过 ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
