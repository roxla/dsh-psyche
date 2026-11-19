// 用量聚合（纯函数，零 IO）：输入「一次模型调用一条采样」，输出总量 → 按会话 → 按小时的视图。
// 不读时钟（now 可注入）、不碰数据库，只读入参返回新对象，因此可直接单测；调用方是使用面板与 index.ts。
//
// 两条容易算错的地方，这里都按事实处理：
//   1. **每条采样按自己的时间戳计价**：同一段对话跨了 10:00，前半段空闲价、后半段高峰价，
//      不能拿「现在」的档位乘全部 token。
//   2. **轮次/步数按 (session, turn, step) 去重**：一次重试会产生多条采样，但它们仍是同一轮
//      同一步，数成三步会把「平均每轮」算小；不变量：合计 token 永远等于各会话之和。

import {
  DEFAULT_PRICE_TABLE,
  addBuckets,
  hitRateOf,
  isPeakAt,
  normalizeUsage,
  priceUsage,
  ratesAt,
  totalTokensOf,
  type PriceTable,
  type PriceTier,
  type UsageBuckets,
  type UsageCost
} from './pricing.js';

/**
 * 一条用量采样 = 一次模型调用的账本记录。
 *
 * `usage` 应是 `normalizeUsage` 归一化后的桶（`sampleOf` 会做），四桶互斥、加起来是全部 token。
 * `turn` / `step` / `retry` 可缺省；缺省按 -1 参与去重键，所以「不知道第几步」的多条采样
 * 会被算成同一步——这是保守选择：宁可少算轮次，也不要凭空多算。
 */
export interface UsageSample {
  sessionId: string;
  /** 采样时刻（毫秒）。计价与分桶都用它。 */
  at: number;
  model?: string;
  usage: UsageBuckets;
  turn?: number;
  step?: number;
  retry?: number;
  /** 会话标题/来源，界面上用来认人。 */
  label?: string;
  /**
   * 用途标签（`diary` / `reflection` / `summary` …）。
   *
   * 有它时聚合**按用途分组**（而不是按会话）：插件的自用调用全挂在同一个逻辑会话上，
   * 按会话分只会得到一行「psyche」，看不出钱花在哪件事上。
   */
  purpose?: string;
}

/**
 * 一段（会话/总量）的金额合计。
 *
 * `peak` / `off` 是按每条采样**自己的档位**拆出来的金额，二者之和 = `total`；
 * `estimatedCount` 是走了兜底价的采样条数，>0 时界面要标「估算」。
 */
export interface UsageCostSum {
  total: number;
  currency: string;
  symbol: string;
  peak: number;
  off: number;
  estimatedCount: number;
}

/**
 * 按会话归并后的一行。
 *
 * `calls` 是采样条数（重试也各算一条），`turns` / `steps` 是去重后的轮次/步数；
 * `label` 已做兜底（空标题退化成 sessionId），界面不会出现空名字。
 */
export interface SessionUsage {
  sessionId: string;
  label: string;
  calls: number;
  turns: number;
  steps: number;
  buckets: UsageBuckets;
  tokens: number;
  /** 缓存命中率（同 `hitRateOf` 口径）：会话之间可以横向比「谁读历史更便宜」。 */
  hitRate: number;
  cost: UsageCostSum;
  lastAt: number;
}

/**
 * 一个整点桶：横轴上的一根柱子（`at` 是本地时区的整点时间戳）。
 *
 * `tier` 是这个整点**所属的计价档位**：跨整点的采样已经分别落格，所以一个桶只有一个档位；
 * 界面用它给柱子分色（高峰 ×2），不参与金额计算（金额在采样层已经按自己的时刻算完）。
 */
export interface HourBucket {
  /** 整点时间戳。 */
  at: number;
  tokens: number;
  cost: number;
  calls: number;
  tier: PriceTier;
}

/**
 * 总量层。
 *
 * `avgCostPerTurn` = 总金额 / 去重轮次，轮次为 0 时直接给 0（不做除零）；
 * `hitRate` 是缓存命中率（0–1，来自 `hitRateOf`，分母是输入相关的桶）。
 */
export interface UsageTotals {
  calls: number;
  sessions: number;
  turns: number;
  steps: number;
  buckets: UsageBuckets;
  tokens: number;
  hitRate: number;
  cost: UsageCostSum;
  avgCostPerTurn: number;
}

/**
 * 一次聚合的完整返回体（可 JSON 序列化，直接喂给面板）。
 *
 * `priceTable` 是**聚合时刻**的现行单价摘要（「现在是什么价」），与上面的金额不是一回事：
 * 金额按每条采样自己的时刻算，这里只用于展示。`notes` 是给人看的提示，不参与计算。
 */
export interface UsagePayload {
  ok: boolean;
  at: number;
  windowHours: number;
  priceTable: {
    version: number;
    currency: string;
    symbol: string;
    peakMultiplier: number;
    tier: string;
    tierLabel: string;
    model: string;
    modelLabel: string;
    estimated: boolean;
    cacheHit: number;
    cacheMiss: number;
    output: number;
  };
  totals: UsageTotals;
  bySession: SessionUsage[];
  byHour: HourBucket[];
  notes: string[];
}

/** 空桶模板。每次使用都要复制（`{ ...EMPTY_BUCKETS }`），共享引用会被累加改掉。 */
export const EMPTY_BUCKETS: UsageBuckets = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 };
/** 空金额模板（币种/符号取默认价目表）；同样每次复制后再累加。 */
export const EMPTY_COST: UsageCostSum = {
  total: 0,
  currency: DEFAULT_PRICE_TABLE.currency,
  symbol: DEFAULT_PRICE_TABLE.symbol,
  peak: 0,
  off: 0,
  estimatedCount: 0
};

/**
 * 把一条采样的金额并进合计（纯函数，返回新对象）。
 *
 * 币种/符号以「后出现的非空值」为准（`cost.currency || into.currency`），空串不覆盖已有币种；
 * `peak` / `off` 按这条采样**自己的** `tier` 归边，互斥且和等于 `total`。
 */
function addCost(into: UsageCostSum, cost: UsageCost): UsageCostSum {
  return {
    total: into.total + cost.total,
    currency: cost.currency || into.currency,
    symbol: cost.symbol || into.symbol,
    peak: into.peak + (cost.tier === 'peak' ? cost.total : 0),
    off: into.off + (cost.tier === 'off' ? cost.total : 0),
    estimatedCount: into.estimatedCount + (cost.estimated ? 1 : 0)
  };
}

/**
 * 把一条采样的 usage 归一化；顺带容忍外部直接给的 TokenUsage 形状。
 *
 * 参数：`input.sessionId` 必填；`input.at` 非有限时按 0（1970 年，必然空闲价）；
 * `input.usage` 交给 `normalizeUsage`，因此 `inputTokens` 与 `cacheHit` 两种叫法都认。
 * 返回：全新的 `UsageSample`，不持有入参引用。
 */
export function sampleOf(input: {
  sessionId: string;
  at: number;
  usage: unknown;
  model?: string;
  turn?: number;
  step?: number;
  retry?: number;
  label?: string;
  purpose?: string;
}): UsageSample {
  return {
    sessionId: input.sessionId,
    at: Number.isFinite(input.at) ? input.at : 0,
    model: input.model,
    usage: normalizeUsage(input.usage),
    turn: input.turn,
    step: input.step,
    retry: input.retry,
    label: input.label,
    purpose: input.purpose
  };
}

/** 会话显示名：标题去空白后非空就用它，否则退回 sessionId（界面上不能出现空名字）。 */
function normalizeLabel(sample: UsageSample): string {
  const label = sample.label?.trim();
  return label && label.length > 0 ? label : sample.sessionId;
}

/**
 * 按小时分桶键：本地时区的整点（分/秒/毫秒归零）。
 *
 * 用 `setMinutes` 而不是「时间戳除以 3600000 取整」，是为了让时区偏移（含夏令时）交给 Date 处理，
 * 否则跨夏令时的桶会错位一小时。
 */
function hourStartOf(atMs: number): number {
  const d = new Date(atMs);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * 聚合参数（全部可选，默认值见 `aggregateUsage` 体内）。
 *
 * `hours` <= 0 表示不设时间窗；`maxBuckets` 只限制**横轴**显示的桶数，不影响总量；
 * `table` 不传就用 `DEFAULT_PRICE_TABLE`。
 */
export interface AggregateOptions {
  now?: number;
  /** 只看最近多少小时；0 或省略表示全部。 */
  hours?: number;
  table?: PriceTable;
  /** 每小时最多几个桶，用来在界面上控制横轴密度。 */
  maxBuckets?: number;
  /**
   * 窗口内没有任何采样时附加的说明。
   *
   * 为什么由调用方给：同样「空」，对话消耗为空和插件自用为空是两件事，
   * 聚合层不该替调用方解释数据从哪来。
   */
  emptyNote?: string;
}

/**
 * 聚合。
 *
 * 没有任何采样时也返回一份结构完整的空结果（ok:true），界面上直接显示「还没有用量记录」，
 * 不需要在渲染层再判一次空。
 *
 * 参数：`samples` 采样数组（顺序无所谓，内部会按 `at` 排序）；`options.now` 注入「现在」（测试用）。
 * 返回：`UsagePayload`。关键顺序：先按时间窗过滤 → 再逐条计价累加 → 最后才裁剪横轴桶。
 */
export function aggregateUsage(samples: readonly UsageSample[], options: AggregateOptions = {}): UsagePayload {
  const table = options.table ?? DEFAULT_PRICE_TABLE;
  const now = options.now ?? Date.now();
  // hours 非正 / NaN 一律当「不设窗口」；下面用 -Infinity 当 from，等于全部纳入。
  const hours = Math.max(0, Number(options.hours) || 0);
  const from = hours > 0 ? now - hours * 3600_000 : -Infinity;

  // 先过滤再排序：排序只影响遍历顺序，不影响合计（金额按各采样自己的 at 算）。
  const inWindow = samples
    .filter((sample) => sample.at >= from)
    .slice()
    .sort((a, b) => a.at - b.at);

  const sessions = new Map<
    string,
    { label: string; id: string; calls: number; turns: Set<string>; steps: Set<string>; buckets: UsageBuckets; cost: UsageCostSum; lastAt: number }
  >();
  const hourly = new Map<number, HourBucket>();
  const notes: string[] = [];

  let totalsBuckets = { ...EMPTY_BUCKETS };
  let totalsCost = { ...EMPTY_COST };
  const allTurns = new Set<string>();
  const allSteps = new Set<string>();

  for (const sample of inWindow) {
    // 每条采样用**自己的** at 计价：跨 10:00 的对话前半段空闲价、后半段高峰价。
    const cost = priceUsage(sample.usage, { model: sample.model, at: sample.at, table });
    // 分组键：有 purpose 就按用途分组（插件的自用调用），否则按会话分组（对话消耗）。
    // 前缀是必要的——否则一个叫 `diary` 的会话 id 会和用途 `diary` 撞成同一行。
    const key = sample.purpose ? `purpose:${sample.purpose}` : sample.sessionId;
    // 去重键带会话前缀（不是分组键）：同一轮里的两次用途不应该被算成两轮。
    const turnKey = `${sample.sessionId}#${sample.turn ?? -1}`;
    const stepKey = `${sample.sessionId}#${sample.turn ?? -1}#${sample.step ?? -1}`;

    const existing = sessions.get(key);
    const target =
      existing ??
      {
        // 行上展示的 id：按用途分组时给用途名，按会话分组时给会话 id（不带内部前缀）。
        id: sample.purpose ?? sample.sessionId,
        label: sample.purpose ?? normalizeLabel(sample),
        calls: 0,
        turns: new Set<string>(),
        steps: new Set<string>(),
        buckets: { ...EMPTY_BUCKETS },
        cost: { ...EMPTY_COST },
        lastAt: 0
      };
    target.calls += 1;
    target.turns.add(turnKey);
    target.steps.add(stepKey);
    target.buckets = addBuckets(target.buckets, sample.usage);
    target.cost = addCost(target.cost, cost);
    // lastAt 取最大；虽然上面已按 at 升序排过，这条不变量仍显式保证，不依赖遍历顺序。
    target.lastAt = Math.max(target.lastAt, sample.at);
    sessions.set(key, target);

    totalsBuckets = addBuckets(totalsBuckets, sample.usage);
    totalsCost = addCost(totalsCost, cost);
    allTurns.add(turnKey);
    allSteps.add(stepKey);

    // 小时桶同样按采样自己的 at 落格：跨整点的调用会分别进两个桶，而不是全塞进结束时刻。
    const hourKey = hourStartOf(sample.at);
    const bucket = hourly.get(hourKey) ?? {
      at: hourKey,
      tokens: 0,
      cost: 0,
      calls: 0,
      // 档位按桶的整点算：整点本身就是档位边界，所以「这一小时是什么价」是确定的。
      tier: (isPeakAt(hourKey, table) ? 'peak' : 'off') as PriceTier
    };
    bucket.tokens += totalTokensOf(sample.usage);
    bucket.cost += cost.total;
    bucket.calls += 1;
    hourly.set(hourKey, bucket);
  }

  // 会话按金额降序、金额相同再按 token 降序：「花钱最多的」排最前，而不是按 id 字典序。
  const bySession: SessionUsage[] = [...sessions.entries()]
    .map(([sessionId, value]) => ({
      sessionId: value.id ?? sessionId,
      label: value.label,
      calls: value.calls,
      turns: value.turns.size,
      steps: value.steps.size,
      buckets: value.buckets,
      tokens: totalTokensOf(value.buckets),
      hitRate: hitRateOf(value.buckets),
      cost: value.cost,
      lastAt: value.lastAt
    }))
    .sort((a, b) => b.cost.total - a.cost.total || b.tokens - a.tokens);

  // 横轴按时间升序（最近的在最右）；桶数超限只裁掉最早的一段，见下面的 note。
  let byHour = [...hourly.values()].sort((a, b) => a.at - b.at);
  const maxBuckets = Math.max(1, Math.round(options.maxBuckets ?? 48));
  if (byHour.length > maxBuckets) {
    // 桶太多时只留最近的，并在 note 里说明——不把历史压缩成假数据
    const dropped = byHour.length - maxBuckets;
    byHour = byHour.slice(byHour.length - maxBuckets);
    notes.push(`横轴只画了最近 ${maxBuckets} 个小时桶，更早的 ${dropped} 个桶仍计入总量。`);
  }

  // totalTurns 用总量集合的 size：它等于各会话 turns 之和（去重键带 session 前缀，天然不重叠）。
  const totalTurns = allTurns.size;
  const totals: UsageTotals = {
    calls: inWindow.length,
    sessions: sessions.size,
    turns: totalTurns,
    steps: allSteps.size,
    buckets: totalsBuckets,
    tokens: totalTokensOf(totalsBuckets),
    hitRate: hitRateOf(totalsBuckets),
    cost: totalsCost,
    avgCostPerTurn: totalTurns > 0 ? totalsCost.total / totalTurns : 0
  };

  // 下面这份是「现在」的单价摘要，只用于展示：金额已在循环里按各采样的时刻算完，别拿它乘总量。
  const nowRates = ratesAt(undefined, now, table);
  const estimated = totalsCost.estimatedCount > 0;
  if (estimated) notes.push('价目表没覆盖会话用的模型，这几条按兜底价估算（界面标「估算」）。');
  if (inWindow.length === 0) notes.push(options.emptyNote ?? '还没有可统计的用量：会话产生一次模型调用后，这里才会出现数据。');

  return {
    ok: true,
    at: now,
    windowHours: hours,
    priceTable: {
      version: table.version,
      currency: table.currency,
      symbol: table.symbol,
      peakMultiplier: table.peakMultiplier,
      tier: nowRates.tier,
      tierLabel: nowRates.tierLabel,
      model: nowRates.model,
      modelLabel: nowRates.label,
      estimated: nowRates.estimated,
      cacheHit: nowRates.cacheHit,
      cacheMiss: nowRates.cacheMiss,
      output: nowRates.output
    },
    totals,
    bySession,
    byHour,
    notes
  };
}
