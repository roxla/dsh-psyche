/**
 * R8：QQ 回复里「整条只是 psyche 工具标记」的过滤。
 */
import { isPurePsycheToolMarkup } from '../dist/lib/qq-reply-text.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`FAIL ${label}${detail === '' ? '' : ` :: ${detail}`}`)
}

ok('A1 真实泄漏文本被识别', isPurePsycheToolMarkup('\n\n<psyche_recall">\n'))
ok('A2 正常关闭标签被识别', isPurePsycheToolMarkup('</psyche_recall>'))
ok('A3 前后空白不影响', isPurePsycheToolMarkup('  <psyche_remember>  '))
ok('A4 正常中文正文不误伤', !isPurePsycheToolMarkup('好，我记下了。'))
ok('A5 带正文的工具标记不误伤', !isPurePsycheToolMarkup('<psyche_recall"> 查一下'))
ok('A6 空文本不处理', !isPurePsycheToolMarkup('   '))

console.log(`qq-reply-text: ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
