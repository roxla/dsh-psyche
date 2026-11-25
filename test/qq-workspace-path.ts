// QQ 工作区目录解析的行为锁。
//
// 锁的是这次线上问题的成因：默认值曾经算成相对路径 `QQ 聊天`，宿主
// `workspace/create` 直接拒收（`Workspace path is not fully qualified`），
// 工作区建不出来，QQ 会话只能留在「未分组」。
//
// 还锁第二层：默认值不能只按 `process.cwd()` 推。宿主按会话 header 的 cwd 归属
// 工作区，历史 QQ 会话的 cwd 早就定死在当时解析出来的绝对路径上，而插件进程的
// 工作目录会随宿主升级变化——所以要先从磁盘上认领「已经有 QQ 会话」的那个目录。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  QQ_WORKSPACE_DIR_NAME,
  decodeSessionDirName,
  defaultSessionsDirs,
  findExistingQqSessionCwd,
  isQualifiedWorkspacePath,
  resolveQqWorkspaceCwd,
} from '../dist/lib/qq-workspace-path.js'

let passed = 0
let failed = 0
const eq = (name: string, actual: unknown, expected: unknown): void => {
  if (actual === expected) {
    passed += 1
    console.log(`  ok ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL ${name} { actual: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)} }`)
}
const ok = (name: string, value: boolean): void => {
  if (value) {
    passed += 1
    console.log(`  ok ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL ${name}`)
}

const BASE = 'D:\\project\\psyche'

/** 宿主编码规则的逆运算，只给夹具用：盘符去掉冒号，分隔符与段内特殊字符都转义。 */
const encode = (path: string): string => {
  const segments = path.split('\\').filter((segment) => segment !== '')
  const escaped = segments.map((segment, index) => {
    const text = index === 0 ? segment.replace(':', '') : segment
    return text.replace(/[^A-Za-z0-9._]/g, (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  })
  return `--${escaped.join('-')}--`
}

console.log('[qq-workspace-path] 常量')
eq('目录名就是侧栏标题', QQ_WORKSPACE_DIR_NAME, 'QQ 聊天')

console.log('[qq-workspace-path] 显式配置')
eq(
  '绝对路径配置原样保留',
  resolveQqWorkspaceCwd({ configured: 'D:\\proj\\QQ 聊天', cwd: BASE }),
  'D:\\proj\\QQ 聊天',
)
eq(
  '相对路径配置按宿主工作目录补全',
  resolveQqWorkspaceCwd({ configured: 'QQ 聊天', cwd: BASE }),
  join(BASE, 'QQ 聊天'),
)
eq('配置优先于默认规则', resolveQqWorkspaceCwd({ configured: 'E:\\qq', cwd: BASE }), 'E:\\qq')
eq(
  '配置优先于磁盘上已有的会话目录',
  resolveQqWorkspaceCwd({ configured: 'E:\\qq', existing: 'D:\\project\\psyche\\QQ 聊天', cwd: BASE }),
  'E:\\qq',
)
ok('相对配置补全后是绝对路径', isAbsolute(resolveQqWorkspaceCwd({ configured: 'QQ 聊天', cwd: BASE })))

console.log('[qq-workspace-path] 沿用已有 QQ 会话目录')
eq(
  '没有配置时先用磁盘上已有的会话目录',
  resolveQqWorkspaceCwd({ configured: '', existing: 'D:\\project\\psyche\\QQ 聊天', cwd: 'C:\\Users\\x\\.dsh\\profiles\\desktop' }),
  'D:\\project\\psyche\\QQ 聊天',
)
eq(
  '已有会话目录优先于宿主工作目录（这就是「未分组」的修法）',
  resolveQqWorkspaceCwd({ configured: '', existing: 'D:\\project\\psyche\\QQ 聊天', cwd: BASE }) === 'C:\\Users\\x',
  false,
)
eq(
  '已有目录是空白时忽略',
  resolveQqWorkspaceCwd({ configured: '', existing: '   ', cwd: BASE }),
  join(BASE, 'QQ 聊天'),
)
eq('已有目录 null 时退回宿主工作目录', resolveQqWorkspaceCwd({ configured: '', existing: null, cwd: BASE }), join(BASE, 'QQ 聊天'))

console.log('[qq-workspace-path] 默认规则')
eq('默认落在宿主工作目录下', resolveQqWorkspaceCwd({ configured: '', cwd: BASE }), join(BASE, 'QQ 聊天'))
eq(
  '默认结果不是相对路径（这就是线上事故的形状）',
  resolveQqWorkspaceCwd({ configured: '', cwd: BASE }) === 'QQ 聊天',
  false,
)
ok('默认结果总是绝对路径', isAbsolute(resolveQqWorkspaceCwd({ configured: '', cwd: BASE })))
eq('空白配置当成没配置', resolveQqWorkspaceCwd({ configured: '   ', cwd: BASE }), join(BASE, 'QQ 聊天'))
eq(
  '末尾分隔符会被规范化掉',
  resolveQqWorkspaceCwd({ configured: join(BASE, 'QQ 聊天') + '\\', cwd: BASE }),
  join(BASE, 'QQ 聊天'),
)
eq('不传 cwd 时用进程工作目录兜底', resolveQqWorkspaceCwd({ configured: '' }), join(process.cwd(), 'QQ 聊天'))
eq('不传 cwd 的相对配置也能补全', resolveQqWorkspaceCwd({ configured: 'QQ 聊天' }), resolve('QQ 聊天'))

console.log('[qq-workspace-path] 全限定判定')
ok('绝对路径算全限定', isQualifiedWorkspacePath('D:\\proj\\QQ 聊天'))
ok('相对目录名不算全限定（线上事故的那一个）', isQualifiedWorkspacePath('QQ 聊天') === false)
ok('空串不算全限定', isQualifiedWorkspacePath('') === false)
ok('只有空白不算全限定', isQualifiedWorkspacePath('   ') === false)

console.log('[qq-workspace-path] 会话目录名解码')
eq(
  '本机这个目录名解回 QQ 聊天 工作目录',
  decodeSessionDirName('--D-project-psyche-QQ~0020~804A~5929--'),
  'D:\\project\\psyche\\QQ 聊天',
)
eq('普通路径原样解码', decodeSessionDirName('--D-proj-sub--'), 'D:\\proj\\sub')
eq('不是会话目录名就返回 null', decodeSessionDirName('qq-private-10001'), null)
eq('缺后包裹也返回 null', decodeSessionDirName('--D-proj'), null)
eq('盘符不合法返回 null', decodeSessionDirName('--1-proj--'), null)

console.log('[qq-workspace-path] 从磁盘找已有 QQ 会话目录')
const root = mkdtempSync(join(tmpdir(), 'qq-workspace-path-'))
try {
  const sessions = join(root, 'sessions')
  const liveCwd = join(root, 'live cwd')
  mkdirSync(sessions, { recursive: true })
  mkdirSync(liveCwd, { recursive: true })
  mkdirSync(join(sessions, encode(liveCwd), 'qq-private-1'), { recursive: true })
  // 一个已经不存在于磁盘上的 cwd，用来确认不会被误认。
  const deadCwd = join(root, 'dead cwd')
  mkdirSync(join(sessions, encode(deadCwd), 'qq-private-2'), { recursive: true })
  rmSync(deadCwd, { recursive: true, force: true })

  eq('认出已经有 QQ 会话的那个目录', findExistingQqSessionCwd({ sessionsDirs: [sessions] }), liveCwd)
  eq('sessions 根目录不存在时安静返回 null', findExistingQqSessionCwd({ sessionsDirs: [join(root, 'nope')] }), null)

  const emptySessions = join(root, 'empty')
  mkdirSync(join(emptySessions, encode(liveCwd), 'session-x'), { recursive: true })
  eq(
    '目录存在但没有 qq-private-* 子目录不算',
    findExistingQqSessionCwd({ sessionsDirs: [emptySessions] }),
    null,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('[qq-workspace-path] sessions 根目录候选')
ok('带 dataDir 时先看它的兄弟目录', defaultSessionsDirs('C:\\Users\\x\\.dsh\\psyche')[0] === 'C:\\Users\\x\\.dsh\\sessions')
ok('总有一个兜底目录', defaultSessionsDirs('').length >= 1)
ok('没有 dataDir 时只兜底', defaultSessionsDirs('').every((dir) => isAbsolute(dir)))

console.log(`[qq-workspace-path] ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
