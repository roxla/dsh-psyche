/**
 * 人格预设自检（`src/lib/presets.ts`）。
 *
 * 为什么单独测：预设是**只读包内资源**，一旦校验放松，占位提示词就可能被当成正式人格、
 * 或者某份 JSON 悄悄覆盖核心底线。这里把「不可篡改」的每一条都钉住：
 * 白名单、草稿标记、核心承诺只能加不能减、字段与倾向规则。
 *
 * 跑法：`node test/presets.ts`（要求先 `npm run build`）。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CORE_COMMITMENTS,
  DEFAULT_PRESET_ID,
  PRESET_DIR,
  PRESET_IDS,
  SHAPE_KEYS,
  TENDENCY_KEYS,
  findPreset,
  loadPresets,
  mergeCommitments,
  presetPath,
} from '../dist/lib/presets.js'

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

/** 期望抛错且错误码对得上：校验失败必须是结构化错误，不能是 TypeError。 */
function expectError(fn: () => unknown, code: string): { ok: boolean; message: string } {
  try {
    fn()
    return { ok: false, message: '没有抛错' }
  } catch (error) {
    const actual = (error as { code?: string }).code
    return { ok: actual === code, message: String((error as Error).message) }
  }
}

const realDir = fileURLToPath(PRESET_DIR)
const sandbox = mkdtempSync(join(tmpdir(), 'psyche-presets-'))

/** 读真实五份、改其中一份，再整套写到临时目录：包装成「带上来的预设坏了」。 */
function withMutatedPreset(
  mutate: (files: Record<string, Record<string, unknown>>) => void,
  extra?: (dir: string) => void,
): { dir: string; codes: string[]; ok: boolean } {
  const files: Record<string, Record<string, unknown>> = {}
  for (const id of PRESET_IDS) {
    files[id] = JSON.parse(readFileSync(presetPath(realDir, id), 'utf8')) as Record<string, unknown>
  }
  mutate(files)

  const dir = mkdtempSync(join(sandbox, 'case-'))
  for (const [id, body] of Object.entries(files)) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(body, null, 2) + '\n', 'utf8')
  }
  extra?.(dir)

  const result = loadPresets({ dir })
  return { dir, codes: result.problems.map((item) => item.code), ok: result.ok }
}

function main(): void {
  console.log('人格预设自检')

  // ---- 正常加载 ----
  const loaded = loadPresets()
  check('五套预设全部通过校验', loaded.ok && loaded.presets.length === 5, loaded.problems)
  check('没有校验问题', loaded.problems.length === 0, loaded.problems)
  check('id 去重且都在白名单内', new Set(loaded.presets.map((p) => p.presetId)).size === 5)
  check(
    '文件顺序与 PRESET_IDS 一致',
    loaded.presets.map((p) => p.presetId).join(',') === PRESET_IDS.join(','),
  )
  check('默认推荐项是 gentle-firm', DEFAULT_PRESET_ID === 'gentle-firm')

  const recommended = loaded.presets.filter((p) => p.recommended)
  check('全局恰好一套 recommended', recommended.length === 1, recommended.map((p) => p.presetId))
  check('recommended 是 gentle-firm', recommended[0]?.presetId === 'gentle-firm')

  // ---- 正式版标记（persona-presets 五份人格已替换占位草案）----
  check(
    '五套预设都是正式版（draft=false）',
    loaded.presets.every((p) => p.draft === false),
  )
  check(
    '正式版版本号不带 -draft 后缀',
    loaded.presets.every((p) => !/-draft$/i.test(p.presetVersion)),
    loaded.presets.map((p) => [p.presetId, p.presetVersion]),
  )
  check(
    '正文不再是占位草案',
    loaded.presets.every((p) => !/草案|占位|尚未定稿/i.test(p.identity)),
  )
  check(
    '正文长度足够当身份基底（≥200 字）',
    loaded.presets.every((p) => p.identity.trim().length >= 200),
    loaded.presets.map((p) => [p.presetId, p.identity.trim().length]),
  )

  // ---- 结构 ----
  check(
    'shape 六方面齐全且非空',
    loaded.presets.every(
      (p) => SHAPE_KEYS.every((key) => typeof p.shape[key] === 'string' && p.shape[key].length >= 4),
    ),
  )
  check(
    '每套都带至少一条承诺',
    loaded.presets.every((p) => p.commitments.length >= 1),
  )
  check(
    '预设承诺不许用 core- 前缀',
    loaded.presets.every((p) => p.commitments.every((c) => !c.id.startsWith('core-'))),
  )
  check(
    '承诺 id 全局不重复',
    new Set(loaded.presets.flatMap((p) => p.commitments.map((c) => c.id))).size ===
      loaded.presets.reduce((sum, p) => sum + p.commitments.length, 0),
  )
  check(
    'tendencies 的键都在白名单里、值在 0–1',
    loaded.presets.every((p) =>
      p.tendencies.every(
        (t) => (TENDENCY_KEYS as readonly string[]).includes(t.key) && t.initial >= 0 && t.initial <= 1,
      ),
    ),
  )

  // ---- 核心底线 ----
  check('核心承诺四条', CORE_COMMITMENTS.length === 4)
  check(
    '核心承诺全走人批',
    CORE_COMMITMENTS.every((c) => c.changePolicy === 'human_approval'),
  )
  const merged = mergeCommitments(loaded.presets[0])
  check('合并后核心四条排在前面', CORE_COMMITMENTS.every((c, index) => merged[index]?.id === c.id))
  check('合并后数量 = 4 + 预设自带', merged.length === 4 + loaded.presets[0].commitments.length)

  // ---- 查找接口 ----
  check('findPreset 能取到推荐项', findPreset('gentle-firm').presetId === 'gentle-firm')
  const unknownId = expectError(() => findPreset('no-such-preset'), 'E_PRESET_UNKNOWN')
  check('不存在的预设 → E_PRESET_UNKNOWN', unknownId.ok, unknownId.message)

  // ---- 校验：坏数据都要被逐条指出 ----
  {
    const { codes } = withMutatedPreset((files) => {
      delete files['steady-calm']
    }, (dir) => {
      rmSync(join(dir, 'steady-calm.json'), { force: true })
    })
    check('缺文件 → missing-file', codes.includes('missing-file'), codes)
  }
  {
    const { codes } = withMutatedPreset(() => {}, (dir) => {
      writeFileSync(join(dir, 'quiet-warm.json'), '{ 不是合法 JSON', 'utf8')
    })
    check('坏 JSON → bad-json', codes.includes('bad-json'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['gentle-firm'].presetId = 'no-such-preset'
    })
    check('非法 presetId → unknown-preset-id', codes.includes('unknown-preset-id'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['gentle-firm'].presetId = 'direct-sharp'
    })
    check('文件里的 id 与文件名不符 → id-mismatch', codes.includes('id-mismatch'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['gentle-firm'].draft = true
    })
    check('draft 与版本号不一致 → draft-mismatch', codes.includes('draft-mismatch'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['quiet-warm'].recommended = true
    })
    check('第二套 recommended → recommended-mismatch', codes.includes('recommended-mismatch'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      const commitments = files['gentle-firm'].commitments as Array<Record<string, unknown>>
      commitments.push({ id: 'core-privacy', statement: '我说了算', changePolicy: 'human_approval' })
    })
    check('预设想覆盖核心承诺 → core-override', codes.includes('core-override'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      const shape = files['gentle-firm'].shape as Record<string, unknown>
      delete shape.intimacy
    })
    check('shape 缺一方面 → bad-shape', codes.includes('bad-shape'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['gentle-firm'].loadFrom = 'D:/somewhere/else.json'
    })
    check('多出未知字段 → unknown-key', codes.includes('unknown-key'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      const tendencies = files['gentle-firm'].tendencies as Array<Record<string, unknown>>
      tendencies[0].key = 'obedience'
    })
    check('倾向键不在白名单 → bad-tendency', codes.includes('bad-tendency'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      const commitments = files['gentle-firm'].commitments as Array<Record<string, unknown>>
      commitments.push({ ...commitments[0] })
    })
    check('承诺 id 重复 → duplicate-commitment', codes.includes('duplicate-commitment'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['gentle-firm'].identity = '短'
    })
    check('正文太短 → bad-identity', codes.includes('bad-identity'), codes)
  }
  {
    const { codes } = withMutatedPreset((files) => {
      files['gentle-firm'].presetVersion = 'v1'
    })
    check('版本号不是 semver → bad-version', codes.includes('bad-version'), codes)
  }
  {
    // 坏目录整体不可用：findPreset 必须拒绝，而不是悄悄退化成默认值
    const dir = mkdtempSync(join(sandbox, 'broken-'))
    mkdirSync(dir, { recursive: true })
    const broken = expectError(() => findPreset('gentle-firm', { dir }), 'E_PRESET_INVALID')
    check('整套预设坏掉 → E_PRESET_INVALID', broken.ok, broken.message)
  }

  // ---- 幂等：同一份文件读两次结果一致（没有缓存、没有隐藏状态） ----
  const first = JSON.stringify(loadPresets().presets)
  const second = JSON.stringify(loadPresets().presets)
  check('两次加载结果完全一致', first === second)

  // ---- D1-2f：资源一致性（Core 权威 vs 根包迁移期镜像） ----
  {
    const rootMirror = fileURLToPath(new URL('../presets/', import.meta.url))
    const listed = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    const expected = [...PRESET_IDS].map((id) => `${id}.json`).sort()
    const coreFiles = listed(realDir)
    const mirrorFiles = listed(rootMirror)
    const sameList = (names: string[]): boolean => names.length === expected.length && names.every((n, i) => n === expected[i])
    check('Core 资源目录恰好五份白名单 JSON', sameList(coreFiles), coreFiles)
    check('根包镜像恰好五份白名单 JSON', sameList(mirrorFiles), mirrorFiles)
    check('PRESET_DIR 指向 Core 资源目录', realDir.replaceAll('\\', '/').includes('/packages/core/presets'), realDir)
    const diffs: string[] = []
    for (const name of expected) {
      const coreBytes = readFileSync(join(realDir, name))
      const mirrorBytes = readFileSync(join(rootMirror, name))
      if (!coreBytes.equals(mirrorBytes)) diffs.push(name)
    }
    check('Core 资源与根包镜像逐字节一致', diffs.length === 0, diffs)
  }

  console.log(`\n人格预设自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
  rmSync(sandbox, { recursive: true, force: true })
}

main()
