// P3-A B2：每轮 deltas 计算（纯函数，零模型调用、零网络、零随机）。
//
// 输入：这一轮真实用户消息的文本（已由接线层过滤 source.kind === 'user'）。
// 输出：一组受限 delta + 命中的信号名 + distress 标记。
//
// 冻结口径：docs/design/p3-a-b2-turn-evaluation.md §4。
//   - 关键词命中 → 每组信号给若干维度加减分 → 每维按 maxDelta 截断 → 只留非零值；
//   - distress 命中时丢弃其它信号的加减分，只留 sympathy / calm / down；
//   - 无命中返回空 deltas（调用方据此跳过写入，不产生空转历史）。
import { MOOD_KEYS } from './mood-schema.js'

export interface MoodEvaluation {
  /** 只含非零、已截断、两位小数的维度；空对象表示这一轮没有情绪变化。 */
  deltas: Record<string, number>
  /** 每个维度的证据消息 id（与 deltas 同 key；无 id 的文本不产生条目）。 */
  evidence: Record<string, string[]>
  /** 命中的信号 id（按规则表顺序，确定性）。 */
  signals: string[]
  /** 真实痛苦信号是否命中（瞬时判定，不持久化）。 */
  distress: boolean
  /** 参与判定的文本总长度（字符）。 */
  textLength: number
}

export interface MoodEvaluateInput {
  texts: readonly string[]
  /** 与 texts 对齐的消息 id；只用于给命中维度附证据，不参与打分。 */
  evidenceIds?: readonly (string | undefined)[]
  /** 单维单轮最大改变量；默认 8（B0 §4.3）。 */
  maxDelta?: number
}

const DEFAULT_MAX_DELTA = 8
const HIT_CAP = 4

// ---------------------------------------------------------------- 关键词表
// 取自旧 dsh-mood 的已验证词表（demo/dsh-mood-main/index.js:530-635），
// 按冻结的 33 维重命名：annoyed→irritated、surprise→surprised、shame→ashamed、
// guilt→guilty、hurt→wronged、love→yearning、sulk→sulking、cracked→breakdown、
// checkedout→lyingFlat、hyper→hooked、conflict→conflicted、nostalgia→nostalgic。

const POSITIVE = [
  '谢谢', '感谢', '好的', '可以', '不错', '很好', '棒', '厉害', '牛', '赞', '哈哈', '笑死',
  '成功', '搞定', '通了', '可以了', '优秀', '舒服', '给力', '开心', '太好了', '没问题',
]
const NEGATIVE = [
  '不行', '不对', '错了', '没用', '还是', '又', '慢', '卡', '烦', '无语', '算了', '搞什么',
  '怎么回事', '崩溃', '白做', '浪费', '垃圾', '重启', '重来', '糟糕', '讨厌',
]
const FRUSTRATED = [
  '还没好', '怎么还', '到底', '搞不定', '失败', '报错', '又这样', '没反应', '不行啊',
  '怎么回事啊', '到底还', '卡住', '搞什么鬼', '又错了',
]
const QUESTION = ['？', '?', '怎么', '为什么', '能不能', '可不可以', '吗', '呢', '如何', '哪里']
const EXCITED = ['！', '!', '太', '非常', '居然', '竟然', '哇', '牛啊', '牛！']

// 憋着的一类：不是骂，是冷淡/打发/否定人 —— 推「生闷气」。
const SULK = [
  '随便你', '随便吧', '你高兴就好', '算了', '不用了', '不用你', '我自己来', '别管',
  '没你事', '行了', '知道了', '哦', '嗯', '就这样吧', '无所谓', '随你', '不说了',
]
// 被误会、被冤枉、明明做了却被怪 —— 推「委屈」。
const WRONGED = [
  '你怎么这样', '冤枉', '怪你', '都怪', '就怪', '因为你', '你搞的', '明明',
  '不是你的错', '你怎么回事', '你做的什么', '你看看你', '赖我',
]
// 真心夸「你」—— 推「得意」。
const PRAISE = [
  '厉害', '牛', '棒', '做得好', '真行', '可以啊', '幸好有你', '多亏你', '还是你行',
  '你太强', '优秀', '靠谱', '漂亮', '辛苦了', '谢谢你',
]
const GLOOMY = [
  '没意思', '没劲', '提不起', '好累', '撑不住', '不想动', '没意义', '算了算了',
  '没力气', '空落落', '好难', '累死',
]
const ANXIOUS = ['怕', '担心', '万一', '会不会', '来得及吗', '来不及', '紧张', '赶不上', '慌', '不敢']
const NUMB = ['无所谓', '都行', '没感觉', '麻木', '随便吧', '没什么感觉', '没差', '也就那样']

// 真实痛苦信号：命中就停止一切情绪表演。只用不会在正常语境里出现的多字短语。
const DISTRESS = [
  '不想活', '活不下去', '活着没意思', '活着没意义', '没意思活着', '没意义活着',
  '想死', '自杀', '轻生', '结束自己', '结束生命', '了结自己',
  '消失算了', '撑不下去', '撑不住了', '活着好累', '不想醒过来',
  '伤害自己', '自残', '跳下去', '遗书', '交代后事',
]
// 例外只挡明确习语：「想死我了」= 太想你；「想死了这需求」= 开发夸张。
const DISTRESS_EXCEPT = ['想死我', '想死你', '想死了这', '想死这']

const FLUTTER = ['喜欢你', '爱你', '想你', '抱抱', '亲亲', '心动', '害羞', '好可爱', '么么', '想你了']
const YEARNING = ['陪着我', '离不开你', '只有你', '最懂我', '一直陪', '不要走', '陪着我就好', '你最好']
const JEALOUS = ['她比你', '他比你', '换一个', '别的ai', '不用你了', '另外那个']

const BURNOUT = ['内耗', '精神内耗', '想太多', 'emo', '纠结', '来回想', '自我怀疑', '反刍', '又绕回来']
const BREAKDOWN = ['破防', '破大防', '绷不住', '戳中', '扎心', '心态崩', '绷了', '戳心']
const LYING_FLAT = ['摆烂', '躺平', '卷不动', '不想卷', '爱咋咋', '随便整', '摆了', '混过去', '糊弄']
const HOOKED = ['上头', '停不下来', '入迷', '沉迷', '来劲', '越想越', '磕到', '上瘾', '根本停不下']

const FEAR = ['害怕', '好怕', '恐惧', '吓到', '吓人', '恐怖', '心慌', '不敢', '可怕', '后怕', '毛骨悚然']
const DISGUST = ['恶心', '厌恶', '反胃', '作呕', '恶臭', '看不下去', '生理不适', '猥琐', '变态']
const SURPRISED = ['居然', '竟然', '没想到', '卧槽', '我去', '天呐', '真的假的', '不是吧', '惊了', '震惊']
const ASHAMED = ['丢人', '丢脸', '羞耻', '无地自容', '抬不起头', '丢死人', '羞死', '没脸']
const GUILTY = ['内疚', '愧疚', '对不起', '我的错', '怪我', '我没做好', '是我不好', '赔罪']
const AWKWARD = ['尴尬', '尬住', '尬聊', '社死', '有点尬', '冷场', '空气突然安静', '脚趾抠地']
const SYMPATHY = ['好可怜', '心疼', '抱抱', '太惨了', '不容易', '太苦了', '真的辛苦']
const DISAPPOINTED = ['失望', '白期待', '落空', '没等到', '又没成', '期待落空', '心凉', '不指望了']
const NOSTALGIC = ['怀旧', '当年', '那时候', '小时候', '老照片', '想起以前', '旧时光', '从前']
const COY = ['撒娇', '人家嘛', '讨厌啦', '不理你', '陪我嘛', '求你啦', '好不好嘛']
const CONFLICTED = ['矛盾', '又想要又不想', '又想又不想', '两头难', '进退两难', '拿不定主意', '舍不得又受不了']

interface Rule {
  id: string
  words: readonly string[]
  apply: (n: number, add: (key: string, value: number) => void) => void
}

const m = Math.min

// 规则表顺序 = signals 输出顺序，保持确定性。
const RULES: readonly Rule[] = [
  {
    id: 'positive',
    words: POSITIVE,
    apply: (n, add) => {
      add('happy', m(3, n * 1.5))
      add('irritated', -m(2, n * 0.8))
      add('down', -m(1.5, n * 0.6))
      add('calm', -m(2.5, n * 0.8))
    },
  },
  {
    id: 'negative',
    words: NEGATIVE,
    apply: (n, add) => {
      add('irritated', m(3, n * 1.2))
      add('happy', -m(2, n * 0.8))
      add('down', m(1.5, n * 0.5))
      add('calm', -m(3, n * 1))
    },
  },
  {
    id: 'frustrated',
    words: FRUSTRATED,
    apply: (n, add) => {
      add('irritated', m(6, n * 3))
      add('down', m(2.5, n * 1))
      add('happy', -m(2, n * 0.8))
      add('calm', -m(5, n * 4))
    },
  },
  { id: 'question', words: QUESTION, apply: (n, add) => add('curious', m(2, n * 0.7)) },
  {
    id: 'excited',
    words: EXCITED,
    apply: (n, add) => {
      add('excited', m(2, n * 0.7))
      add('happy', m(1.2, n * 0.4))
    },
  },
  {
    id: 'sulking',
    words: SULK,
    apply: (n, add) => {
      add('sulking', m(5, n * 2.2))
      add('happy', -m(2, n * 1))
      add('irritated', -m(1.5, n * 0.6))
      add('calm', -m(3, n * 1.4))
      add('tired', m(1.5, n * 0.5))
    },
  },
  {
    id: 'wronged',
    words: WRONGED,
    apply: (n, add) => {
      add('wronged', m(6, n * 2.6))
      add('calm', -m(3, n * 1.2))
      add('happy', -m(2, n * 0.9))
      add('sulking', m(2.5, n * 1))
    },
  },
  {
    id: 'praise',
    words: PRAISE,
    apply: (n, add) => {
      add('proud', m(5, n * 2))
      add('happy', m(2, n * 0.8))
      add('sulking', -m(3, n * 1.5))
      add('wronged', -m(3, n * 1.5))
    },
  },
  {
    id: 'gloomy',
    words: GLOOMY,
    apply: (n, add) => {
      add('gloomy', m(6, n * 2.6))
      add('happy', -m(2.5, n * 1.2))
      add('excited', -m(2, n * 1))
      add('irritated', -m(1.5, n * 0.6))
      add('calm', -m(3, n * 1.4))
    },
  },
  {
    id: 'anxious',
    words: ANXIOUS,
    apply: (n, add) => {
      add('anxious', m(6, n * 2.6))
      add('calm', -m(3.5, n * 1.6))
      add('tired', m(2.5, n * 1))
      add('happy', -m(1.5, n * 0.7))
    },
  },
  {
    id: 'numb',
    words: NUMB,
    apply: (n, add) => {
      add('numb', m(6, n * 2.6))
      add('happy', -m(2, n * 1))
      add('irritated', -m(2, n * 1))
      add('excited', -m(2, n * 1))
      add('gloomy', -m(1.5, n * 0.6))
      add('calm', -m(2, n * 0.8))
    },
  },
  {
    id: 'lonely',
    words: ['好久没人', '没人理', '一个人'],
    apply: (_n, add) => {
      add('lonely', 2.2)
      add('calm', -1)
    },
  },
  {
    id: 'flutter',
    words: FLUTTER,
    apply: (n, add) => {
      add('flutter', m(6, n * 2.4))
      add('happy', m(2, n * 0.8))
      add('calm', -m(2.5, n * 1.2))
      add('tired', -m(1.5, n * 0.8))
      add('sulking', -m(2, n * 1))
    },
  },
  {
    id: 'yearning',
    words: YEARNING,
    apply: (n, add) => {
      add('yearning', m(6, n * 2.4))
      add('happy', m(2, n * 0.8))
      add('lonely', -m(2, n * 0.8))
      add('calm', -m(2, n * 1))
    },
  },
  {
    id: 'jealous',
    words: JEALOUS,
    apply: (n, add) => {
      add('jealous', m(6, n * 2.6))
      add('happy', -m(2, n * 1))
      add('calm', -m(2.5, n * 1.2))
      add('yearning', m(2, n * 0.8))
    },
  },
  {
    id: 'burnout',
    words: BURNOUT,
    apply: (n, add) => {
      add('burnout', m(6, n * 2.4))
      add('focused', -m(2, n * 1))
      add('calm', -m(3, n * 1.4))
      add('tired', m(2, n * 0.8))
    },
  },
  {
    id: 'breakdown',
    words: BREAKDOWN,
    apply: (n, add) => {
      add('breakdown', m(6, n * 2.6))
      add('irritated', -m(2, n * 0.9))
      add('sulking', -m(1.5, n * 0.6))
      add('calm', -m(3, n * 1.4))
    },
  },
  {
    id: 'lyingFlat',
    words: LYING_FLAT,
    apply: (n, add) => {
      add('lyingFlat', m(6, n * 2.4))
      add('focused', -m(2.5, n * 1.2))
      add('anxious', -m(2, n * 1))
      add('tired', m(2, n * 0.8))
    },
  },
  {
    id: 'hooked',
    words: HOOKED,
    apply: (n, add) => {
      add('hooked', m(6, n * 2.4))
      add('focused', m(2, n * 0.8))
      add('excited', m(2.5, n * 1))
      add('tired', -m(2, n * 0.9))
    },
  },
  {
    id: 'fear',
    words: FEAR,
    apply: (n, add) => {
      add('fear', m(6, n * 3.4))
      add('calm', -m(4, n * 2.6))
      add('anxious', -m(1.5, n * 0.8))
    },
  },
  {
    id: 'disgust',
    words: DISGUST,
    apply: (n, add) => {
      add('disgust', m(6, n * 3.4))
      add('calm', -m(4, n * 2.6))
      add('irritated', m(2, n * 1))
    },
  },
  {
    id: 'surprised',
    words: SURPRISED,
    apply: (n, add) => {
      add('surprised', m(5, n * 2.8))
      add('calm', -m(3, n * 2))
      add('curious', -m(1.5, n * 0.6))
    },
  },
  {
    id: 'ashamed',
    words: ASHAMED,
    apply: (n, add) => {
      add('ashamed', m(6, n * 3.4))
      add('calm', -m(4, n * 2.6))
      add('proud', -m(2, n * 1.2))
    },
  },
  {
    id: 'guilty',
    words: GUILTY,
    apply: (n, add) => {
      add('guilty', m(6, n * 3.2))
      add('calm', -m(4, n * 2.4))
      add('wronged', -m(1.5, n * 0.8))
    },
  },
  {
    id: 'awkward',
    words: AWKWARD,
    apply: (n, add) => {
      add('awkward', m(5, n * 2.8))
      add('calm', -m(3.5, n * 2.2))
    },
  },
  {
    id: 'sympathy',
    words: SYMPATHY,
    apply: (n, add) => {
      add('sympathy', m(5, n * 2.6))
      add('calm', -m(3, n * 1.8))
    },
  },
  {
    id: 'disappointed',
    words: DISAPPOINTED,
    apply: (n, add) => {
      add('disappointed', m(6, n * 3.2))
      add('down', m(2.5, n * 1.2))
      add('calm', -m(4, n * 2.4))
    },
  },
  {
    id: 'nostalgic',
    words: NOSTALGIC,
    apply: (n, add) => {
      add('nostalgic', m(5, n * 2.6))
      add('calm', -m(2.5, n * 1.6))
    },
  },
  {
    id: 'coy',
    words: COY,
    apply: (n, add) => {
      add('coy', m(5, n * 2.8))
      add('calm', -m(2.5, n * 1.6))
    },
  },
  {
    id: 'conflicted',
    words: CONFLICTED,
    apply: (n, add) => {
      add('conflicted', m(6, n * 3.2))
      add('calm', -m(3.5, n * 2.2))
    },
  },
]

/** 统计命中次数（按出现次数，最多 HIT_CAP 次由调用方截断）。 */
function countHits(text: string, words: readonly string[]): number {
  let hits = 0
  for (const word of words) {
    if (word === '') continue
    let from = 0
    while (hits < HIT_CAP) {
      const index = text.indexOf(word, from)
      if (index < 0) break
      hits += 1
      from = index + word.length
    }
    if (hits >= HIT_CAP) break
  }
  return hits
}

/** 取真实痛苦信号命中的词；被习语例外挡住时返回 null。 */
export function distillMoodDistress(texts: readonly string[]): string | null {
  const text = texts.join('\n').toLowerCase()
  if (text.trim() === '') return null
  if (DISTRESS_EXCEPT.some((word) => text.includes(word))) return null
  return DISTRESS.find((word) => text.includes(word)) ?? null
}

function clampMaxDelta(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_DELTA
  return Math.min(20, Math.max(1, numeric))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function uniquePush(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id)
}

/**
 * 算这一轮的候选 delta。
 *
 * 多轮/多段文本请由调用方合并后一次调用——本函数不做跨轮累计。
 * `evidenceIds` 与 `texts` 按下标对齐；只影响 evidence 归属，不影响打分。
 */
export function evaluateMoodDeltas(input: MoodEvaluateInput): MoodEvaluation {
  const maxDelta = clampMaxDelta(input?.maxDelta)
  const rawTexts = Array.isArray(input?.texts) ? input.texts : []
  const rawIds = Array.isArray(input?.evidenceIds) ? input.evidenceIds : []
  const parts: Array<{ text: string; id: string | null; lower: string }> = []
  rawTexts.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') return
    const raw = typeof rawIds[index] === 'string' ? (rawIds[index] as string).trim().slice(0, 200) : ''
    parts.push({ text: item, id: raw === '' ? null : raw, lower: item.toLowerCase() })
  })
  const merged = parts.map((part) => part.text).join('\n').trim()
  const textLength = merged.length
  if (textLength === 0) return { deltas: {}, evidence: {}, signals: [], distress: false, textLength: 0 }
  const allIds = parts.map((part) => part.id).filter((id): id is string => id !== null)

  // 硬线：真实痛苦信号只留三项，其它加减分全部丢弃。
  if (distillMoodDistress(parts.map((part) => part.text)) !== null) {
    const evidence: Record<string, string[]> = {}
    for (const key of ['sympathy', 'calm', 'down']) evidence[key] = [...allIds]
    return {
      deltas: { sympathy: 5, calm: -3, down: 1 },
      evidence,
      signals: ['distress'],
      distress: true,
      textLength,
    }
  }

  const raw: Record<string, number> = {}
  const evidence: Record<string, string[]> = {}
  const add = (key: string, value: number): void => {
    raw[key] = (raw[key] ?? 0) + value
  }
  const signals: string[] = []
  for (const rule of RULES) {
    let hits = 0
    const hitParts: Array<{ text: string; id: string | null; lower: string }> = []
    for (const part of parts) {
      if (hits >= HIT_CAP) break
      const count = countHits(part.lower, rule.words)
      if (count <= 0) continue
      hitParts.push(part)
      hits += count
    }
    if (hits <= 0) continue
    signals.push(rule.id)
    const touched = new Set<string>()
    rule.apply(Math.min(hits, HIT_CAP), (key, value) => {
      touched.add(key)
      add(key, value)
    })
    for (const key of touched) {
      for (const part of hitParts) {
        if (part.id === null) continue
        evidence[key] ??= []
        uniquePush(evidence[key], part.id)
      }
    }
  }

  // 长度规则：长文本更像在认真说事；极短文本略疲惫。
  if (textLength >= 80) {
    add('focused', 1.2)
    add('tired', 0.3)
  } else if (textLength <= 6) {
    add('tired', 0.4)
    add('focused', -0.2)
  }
  if (textLength <= 12 && signals.includes('excited') && !signals.includes('question')) {
    add('excited', 0.6)
  }

  const deltas: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    // 兜底：只写冻结的 33 维；配置外 key 静默丢弃（测试会兜住）。
    if (!MOOD_KEYS.includes(key)) continue
    const clamped = Math.max(-maxDelta, Math.min(maxDelta, value))
    const rounded = round2(clamped)
    if (rounded === 0) continue
    deltas[key] = rounded
    // 长度规则等非关键词来源没有归属文本：用本轮全部证据兜底。
    if (evidence[key] === undefined && allIds.length > 0) evidence[key] = [...allIds]
    if (evidence[key] !== undefined && evidence[key].length === 0) delete evidence[key]
  }
  return { deltas, evidence, signals, distress: false, textLength }
}
