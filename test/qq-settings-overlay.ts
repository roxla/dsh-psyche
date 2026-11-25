// Q1：QQ 访问控制与默认模型的插件覆盖层。
//
// 只验证覆盖层自己的契约（继承 / 覆盖 / 恢复 / 冲突 / 损坏 / 串行），
// 不证明控制中心路由已接线，也不证明宿主 GUI 里的按钮可用。
//
// 五条关键用例（外部评审要求，互相不能替代）：
//   ① 没有覆盖记录时整组继承宿主值，来源标 host；
//   ② 保存 access 之后来源变 overlay，且 model 组保持不动；
//   ③ 同一份表单用旧 revision 再保存 → 冲突且磁盘内容不变；
//   ④ 非法 QQ 号 → 拒绝整次写入，磁盘内容不变；
//   ⑤ 覆盖文件损坏 → 读与写都拒绝，原文件一个字节都不动。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QqOverlayConflictError,
  QqOverlayCorruptError,
  QqOverlayValidationError,
  QqSettingsOverlay,
} from '../dist/lib/qq-settings-overlay.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const HOST_ACCESS = { owner: '695115698', extra: ['10001'], groups: ['70001'] }
const HOST_MODEL = { provider: 'deepseek-account', model: 'deepseek-flash' }

function fixture(): { dir: string; file: string; overlay: QqSettingsOverlay } {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-overlay-'))
  const file = join(dir, 'qq-overrides.json')
  return { dir, file, overlay: new QqSettingsOverlay({ file }) }
}

async function expectRejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null, `期望抛出 ${code}，实际没有抛`)
  const actual = (caught as { code?: string }).code
  assert.equal(actual, code, `期望错误码 ${code}，实际 ${String(actual)}`)
}

// ① 没有覆盖文件：两组都继承宿主值，revision 为 0，不落盘。
{
  const { dir, file, overlay } = fixture()
  await test('没有覆盖记录时整组继承宿主值', () => {
    const snapshot = overlay.effective(HOST_ACCESS, HOST_MODEL)
    assert.equal(snapshot.revision, 0)
    assert.equal(snapshot.hasAccessOverride, false)
    assert.equal(snapshot.hasModelOverride, false)
    assert.equal(snapshot.accessSource, 'host')
    assert.equal(snapshot.modelSource, 'host')
    assert.deepEqual(snapshot.access, HOST_ACCESS)
    assert.deepEqual(snapshot.modelSelection, HOST_MODEL)
    assert.equal(existsSync(file), false, '只读不应该建文件')
  })
  rmSync(dir, { recursive: true, force: true })
}

// ② 保存 access：来源变 overlay，model 组保持继承。
{
  const { dir, overlay } = fixture()
  await test('保存 access 后来源变 overlay，model 组不动', async () => {
    const revision = await overlay.saveAccess({ owner: '695115698', extra: ['3320044'] }, 0)
    assert.equal(revision, 1)
    const snapshot = overlay.effective(HOST_ACCESS, HOST_MODEL)
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.hasAccessOverride, true)
    assert.equal(snapshot.hasModelOverride, false)
    assert.equal(snapshot.accessSource, 'overlay')
    assert.equal(snapshot.modelSource, 'host')
    assert.deepEqual(snapshot.access, { owner: '695115698', extra: ['3320044'], groups: [] })
    assert.deepEqual(snapshot.modelSelection, HOST_MODEL, 'model 组应该还在继承宿主')
  })
  rmSync(dir, { recursive: true, force: true })
}

// ③ 旧 revision 再保存 → 冲突，磁盘内容保持第一次的结果。
{
  const { dir, file, overlay } = fixture()
  await test('用过期 revision 保存被拒且不覆盖别人刚写的值', async () => {
    await overlay.saveAccess({ owner: '111111', extra: [] }, 0)
    const before = readFileSync(file, 'utf8')
    await expectRejects(() => overlay.saveAccess({ owner: '222222', extra: [] }, 0), 'E_REVISION_CONFLICT')
    assert.equal(readFileSync(file, 'utf8'), before, '冲突时磁盘不应被改动')
    const snapshot = overlay.effective(HOST_ACCESS, HOST_MODEL)
    assert.deepEqual(snapshot.access, { owner: '111111', extra: [], groups: [] })
  })
  rmSync(dir, { recursive: true, force: true })
}

// ④ 非法 QQ 号 → 整次拒绝，一个字节都不写。
{
  const { dir, file, overlay } = fixture()
  await test('非法 QQ 号拒绝整次写入', async () => {
    await expectRejects(() => overlay.saveAccess({ owner: 'abc', extra: [] }, 0), 'E_VALIDATION')
    await expectRejects(() => overlay.saveAccess({ owner: '695115698', extra: ['10*'] }, 0), 'E_VALIDATION')
    assert.equal(existsSync(file), false, '校验失败不应该落盘')
  })
  rmSync(dir, { recursive: true, force: true })
}

// ⑤ 覆盖文件损坏：读抛错、写拒绝、原文件不动。
{
  const { dir, file, overlay } = fixture()
  await test('覆盖文件损坏时读写都拒绝且保留原文件', async () => {
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const before = readFileSync(file, 'utf8')
    let readError: unknown = null
    try {
      overlay.effective(HOST_ACCESS, HOST_MODEL)
    } catch (error) {
      readError = error
    }
    assert.ok(readError instanceof QqOverlayCorruptError, '读应该抛 QqOverlayCorruptError')
    await expectRejects(() => overlay.saveAccess({ owner: '111', extra: [] }, 0), 'E_OVERLAY_CORRUPT')
    assert.equal(readFileSync(file, 'utf8'), before, '损坏文件不应被覆盖')
  })
  rmSync(dir, { recursive: true, force: true })
}

// ⑥ extra 去重、剔除 owner、忽略空串。
{
  const { dir, overlay } = fixture()
  await test('extra 去重并剔除 owner', async () => {
    await overlay.saveAccess({ owner: '695115698', extra: ['10001', '10001', '695115698', '', '10002'] }, 0)
    const snapshot = overlay.effective(HOST_ACCESS, HOST_MODEL)
    assert.deepEqual(snapshot.access.extra, ['10001', '10002'])
  })
  rmSync(dir, { recursive: true, force: true })
}

// ⑦ 清除 access：回到宿主值，model 覆盖保留。
{
  const { dir, overlay } = fixture()
  await test('清除 access 回到宿主值且保留 model 覆盖', async () => {
    await overlay.saveAccess({ owner: '111111', extra: [] }, 0)
    await overlay.saveModelSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }, 1)
    const revision = await overlay.clearAccess(2)
    assert.equal(revision, 3)
    const snapshot = overlay.effective(HOST_ACCESS, HOST_MODEL)
    assert.equal(snapshot.hasAccessOverride, false)
    assert.equal(snapshot.accessSource, 'host')
    assert.deepEqual(snapshot.access, HOST_ACCESS)
    assert.equal(snapshot.hasModelOverride, true, 'model 组不该被连带清掉')
    assert.deepEqual(snapshot.modelSelection, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
  rmSync(dir, { recursive: true, force: true })
}

// ⑧ 串行：两个「读到同一个 revision 再写」的保存，第二个必须冲突而不是互相覆盖。
{
  const { dir, overlay } = fixture()
  await test('并发保存只有一个成功，另一个冲突', async () => {
    const results = await Promise.allSettled([
      overlay.saveAccess({ owner: '111111', extra: [] }, 0),
      overlay.saveAccess({ owner: '222222', extra: [] }, 0),
    ])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')
    assert.equal(fulfilled.length, 1, '应该恰好一个成功')
    assert.equal(rejected.length, 1, '应该恰好一个冲突')
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string }
    assert.equal(reason.code, 'E_REVISION_CONFLICT')
  })
  rmSync(dir, { recursive: true, force: true })
}

// ⑨ 模型选择：provider/model 必填，effort 可空。
{
  const { dir, overlay } = fixture()
  await test('模型选择必填校验与 effort 可空', async () => {
    await expectRejects(() => overlay.saveModelSelection({ provider: '', model: 'm' }, 0), 'E_VALIDATION')
    await expectRejects(() => overlay.saveModelSelection({ provider: 'p', model: '' }, 0), 'E_VALIDATION')
    const revision = await overlay.saveModelSelection({ provider: 'p', model: 'm' }, 0)
    assert.equal(revision, 1)
    const snapshot = overlay.effective(HOST_ACCESS, HOST_MODEL)
    assert.deepEqual(snapshot.modelSelection, { provider: 'p', model: 'm' })
    assert.equal('reasoningEffort' in snapshot.modelSelection, false, '空 effort 不落字段')
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log(`qq 覆盖层 ${passed} 通过 0 失败`)
