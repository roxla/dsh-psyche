/**
 * P7/P8-P2：成长候选文本的最低质量闸。
 *
 * 边界：只判断「这段已提炼的 statement 是否像一条可长期沉淀的成长/事实」，
 * 不读取原始对话、不改变 scope/证据、不确认候选；返回 false 时由 reflection
 * 记 candidate_rejected，不写入 growth_candidates。
 */

export type GrowthCandidateKind = 'new_fact' | 'revise_stance' | 'new_habit' | 'identity_growth'

const MIN_MEANINGFUL_CHARS = 6
const MAX_STATEMENT_CHARS = 500

/** 纯话语标记：没有独立命题，不能成为成长候选。 */
const DISCOURSE_ONLY =
  /^(?:总的来说|总而言之|总之|换句话说|也就是说|简单来说|说白了|按.{1,12}来说|从.{1,12}来看|就.{1,12}而言)[。！？!?，,、；;：:\s]*$/

/** 临时任务指令：不是偏好/习惯/承诺，除非同句带第一人称意愿。 */
const IMPERATIVE_START = /^(?:先|请|帮我|麻烦|去|把|改|修|查|跑|执行|打开|关掉|试|再|别|不要)/

/** 第一人称的稳定偏好/习惯/承诺；短句可以靠它豁免长度与指令判定。 */
const FIRST_PERSON_STANCE =
  /我(?:们)?(?:喜欢|不喜欢|讨厌|习惯|希望|想|打算|决定|答应|害怕|擅长|爱|需要|更愿意)/

/** 至少一个实义谓词/存在/动作，挡住「按功能模块来说。」这类碎片。 */
const PREDICATE =
  /(?:是|有|没|觉得|认为|喜欢|讨厌|习惯|答应|决定|计划|需要|应该|可以|擅长|希望|打算|害怕|愿意|爱|喝|吃|玩|睡|工作|学习)/

function meaningfulChars(text: string): number {
  let count = 0
  for (const char of text) {
    if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(char)) count += 1
  }
  return count
}

/**
 * 判断一条候选文本是否值得写入成长账本。
 *
 * @param statement 已提炼的 Artifact Revision 文本
 * @param type 候选类型；当前只用于区分事实与习惯/立场
 */
export function isGrowthCandidateWorthy(statement: string, type: GrowthCandidateKind): boolean {
  const text = String(statement ?? '').trim()
  if (text === '' || Array.from(text).length > MAX_STATEMENT_CHARS) return false

  const bare = text.replace(/[。！？!?，,、；;：:\s]+$/u, '')
  if (bare === '') return false
  const stance = FIRST_PERSON_STANCE.test(bare)
  if (!stance && meaningfulChars(bare) < MIN_MEANINGFUL_CHARS) return false
  if (!stance && DISCOURSE_ONLY.test(bare)) return false
  if (!PREDICATE.test(bare)) return false

  if (IMPERATIVE_START.test(bare) && !stance) return false

  // 事实类至少要有谓词；短事实（如「名字是小林」）允许，但仍禁止指令碎片。
  if (type === 'new_fact') return PREDICATE.test(bare)
  return true
}
