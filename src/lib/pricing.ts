// 价目表与用量计价（纯函数，零 IO）。
//
// 职责：把 DSH 会话事件里的 usage 按「发生在哪个时间段」折算成钱，并给出可显示的单价格式。
// 为什么纯函数：单价来自常量表、时段判定只吃 `atMs`，不读时钟、不读配置、不写库，同输入同输出。
// 被谁调用：`usage.ts`（aggregateUsage 里逐条采样计价）。
// 关键不变量：
//   1. 单价**按发生时刻**取——高峰是空闲的固定倍数，9:59 和 10:01 的价钱不一样；
//   2. 缓存命中 / 未命中 / 写入 / 输出是四个**独立**单价，不能合并成一个 input 价；
//   3. 价目表没覆盖的模型按兜底价算，并在返回值里标 `estimated=true`，界面上写「估算」。
//
// 价目单位：currency/百万 token（unit = 1e6）。

/** 价目表版本。改了单价必须+1，导出的诊断里会带上它。 */
export const PRICE_TABLE_VERSION = 1;

/**
 * 计价档位：`peak` = 高峰，`off` = 空闲。
 * 它不是「现在几点」，而是**这条采样发生时**的档位——所以同一个响应里可以混着两种。
 */
export type PriceTier = 'peak' | 'off';

/** 单个模型在**空闲时段**的单价四元组；高峰价 = 这些数乘 `peakMultiplier`，不单独存。 */
export interface ModelRates {
  /** 每个 1e6 token 的单价（currency 单位）。 */
  cacheHit: number;
  cacheMiss: number;
  cacheWrite: number;
  output: number;
}

/** 整张价目表：单价、高峰系数与时段规则、模型清单、未知模型时的兜底。 */
export interface PriceTable {
  version: number;
  currency: string;
  symbol: string;
  unit: number;
  peakMultiplier: number;
  /** 高峰窗口，按北京时间的小时数半开区间 [start, end)。 */
  peakWindows: ReadonlyArray<readonly [number, number]>;
  /** 高峰只在周一至周五；1=周一 … 7=周日。 */
  peakWeekdays: readonly number[];
  models: Readonly<Record<string, { label: string; off: ModelRates }>>;
  fallbackModel: string;
}

/**
 * 默认价目表（DeepSeek 官方价，CNY / 百万 token，**空闲时段**单价）。
 *
 * 2026-09-10 起的口径：高峰 = 工作日 09:00–12:00 与 14:00–18:00，
 * 其余时段（含整个周末）都是空闲；高峰单价 = 空闲 × 2。
 * 离线了一份同日期的参考实现（`dsh-qq-main/src/model-prices.js:85-120`），
 * 两边数字一致；官方改价时只改这里并 +1 版本号。
 */
export const DEFAULT_PRICE_TABLE: PriceTable = Object.freeze({
  version: PRICE_TABLE_VERSION,
  currency: 'CNY',
  symbol: '¥',
  unit: 1e6,
  peakMultiplier: 2,
  peakWindows: Object.freeze([
    Object.freeze([9, 12] as const),
    Object.freeze([14, 18] as const)
  ]),
  peakWeekdays: Object.freeze([1, 2, 3, 4, 5]),
  models: Object.freeze({
    'deepseek-flash': {
      label: 'DeepSeek-V4.1-Flash',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-flash': {
      label: 'DeepSeek-V4.1-Flash（旧名）',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-pro': {
      label: 'DeepSeek-V4-Pro-0813',
      off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
    },
    'deepseek-pro': {
      label: 'DeepSeek-V4-Pro-0813（旧名）',
      off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
    }
  }),
  fallbackModel: 'deepseek-flash'
});

/**
 * 一次调用拆出来的四类 token 桶（账本口径，不是 DSH 原始字段）。
 *
 * 四个桶**互斥**且加起来等于全部 token：`cacheMiss` 已经是「未命中」，
 * 不含 `cacheHit` / `cacheWrite`，所以计价时可以直接各自乘单价相加。
 */
export interface UsageBuckets {
  cacheMiss: number;
  cacheHit: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/** 全零桶。冻结后可直接复用：所有消费方都只读不写，`addBuckets` / `{...}` 都会先复制。 */
export const ZERO_BUCKETS: UsageBuckets = Object.freeze({
  cacheMiss: 0,
  cacheHit: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0
});

/**
 * 「某个模型在某一时刻」解析出来的有效单价。
 *
 * 这里的四个价格**已经乘过高倍率**，可以直接拿去乘 token；不要再乘一次。
 * `estimated=true` 表示模型名没在表里、用了兜底价，界面要标「估算」。
 * `tierLabel` 是给人看的中文，`tier` 才是给代码判分支的。
 */
export interface RatesAt {
  model: string;
  label: string;
  tier: PriceTier;
  tierLabel: string;
  estimated: boolean;
  currency: string;
  symbol: string;
  cacheHit: number;
  cacheMiss: number;
  cacheWrite: number;
  output: number;
}

/** 宽容取数：任何解析不出有限数（NaN / Infinity / 字符串垃圾）的输入都退回 `fallback`。 */
function numberOr(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 把 DSH 的 `TokenUsage` 折成账本口径。
 *
 * DSH 原始字段：`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`。
 * `inputTokens` 在 DSH 里是**全部输入**（含命中部分），所以未命中 = 总输入 − 命中 − 写入，
 * 下限 0。这一步做错会让每次调用都多算一倍输入。
 */
export function normalizeUsage(usage: unknown): UsageBuckets {
  if (!usage || typeof usage !== 'object') return { ...ZERO_BUCKETS };
  const raw = usage as Record<string, unknown>;
  const hit = numberOr(raw.cacheReadTokens ?? raw.cacheHit);
  const write = numberOr(raw.cacheWriteTokens ?? raw.cacheWrite);
  const totalIn = numberOr(raw.inputTokens ?? raw.cacheMiss);
  // 关键：`inputTokens` 在 DSH 里是**全部输入**（已含命中与写入），
  // 所以未命中 = input − cacheRead − cacheWrite，下限 0（脏数据可能减成负数）。
  // 只有拿不到 `inputTokens` 时才退回读 `cacheMiss` 字段本身。
  const hasTotal = Number.isFinite(Number(raw.inputTokens));
  const miss = hasTotal ? Math.max(0, totalIn - hit - write) : numberOr(raw.cacheMiss);
  return {
    cacheMiss: miss,
    cacheHit: hit,
    cacheWrite: write,
    output: numberOr(raw.outputTokens ?? raw.output),
    reasoning: numberOr(raw.reasoningTokens ?? raw.reasoning)
  };
}

/** 两个桶相加（不修改入参）。聚合时逐条累加靠它，`reasoning` 也一起累。 */
export function addBuckets(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    cacheMiss: a.cacheMiss + b.cacheMiss,
    cacheHit: a.cacheHit + b.cacheHit,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning
  };
}

/**
 * 计费 token 总数 = 未命中 + 命中 + 写入 + 输出。
 *
 * `reasoning` **不计入**：思考 token 已经在 output 里算过一次钱，
 * 这里再算一遍会让「总量」和「花销」对不上。
 */
export function totalTokensOf(b: UsageBuckets): number {
  return b.cacheMiss + b.cacheHit + b.cacheWrite + b.output;
}

/** 命中率 = 命中输入 ÷ 全部输入；没有输入时为 0。 */
export function hitRateOf(b: UsageBuckets): number {
  const input = b.cacheMiss + b.cacheHit + b.cacheWrite;
  if (input <= 0) return 0;
  return b.cacheHit / input;
}

/**
 * 某一时刻是否处于高峰。
 *
 * 参数 `atMs`：采样发生的毫秒时间戳（**用它，不用「现在」**）；`table`：价目表。
 * 返回：是否高峰。非法时间戳返回 false（宁可少算，也不让 NaN 传染金额）。
 *
 * 周末整天不是高峰；节假日按调用方传入的日期集合判断（默认空集合，
 * 也就是「不认节假日」——宁可多算一次高峰，也不要把用户的钱算少）。
 */
export function isPeakAt(atMs: number, table: PriceTable = DEFAULT_PRICE_TABLE): boolean {
  const d = new Date(atMs);
  if (!Number.isFinite(d.getTime())) return false;
  // getDay() 里周日是 0，而价目表用 1=周一 … 7=周日，这里先换算再查。
  const weekday = d.getDay() === 0 ? 7 : d.getDay();
  if (!table.peakWeekdays.includes(weekday)) return false;
  const hour = d.getHours();
  // 半开区间 [start, end)：12:00 整点已经不算高峰（与官方「12 点起空闲」一致）。
  return table.peakWindows.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 用设置里的覆盖项合并出一张完整价目表（深合并，只覆盖传进来的字段）。
 *
 * 参数 `override`：插件设置里的部分价目表；null / 缺省直接用默认表。
 * 返回：一张**完整**的表——`fallbackModel` 永远沿用默认值，界面上不能指向一个不存在的兜底。
 *
 * 边界：
 * - 新模型先继承同名默认模型的价，没同名就继承兜底模型的价，再叠加覆盖项；
 * - 没给 `cacheWrite` 时按 `cacheMiss` 算（写入通常与未命中同价）；
 * - `unit` / `peakMultiplier` 必须 > 0，否则退回默认值（除以 0 会得到 Infinity 金额）。
 */
export function resolvePriceTable(override?: Partial<PriceTable> | null): PriceTable {
  if (!override) return DEFAULT_PRICE_TABLE;
  const models: Record<string, { label: string; off: ModelRates }> = {
    ...DEFAULT_PRICE_TABLE.models
  };
  for (const [name, entry] of Object.entries(override.models ?? {})) {
    const base = DEFAULT_PRICE_TABLE.models[name]?.off ?? DEFAULT_PRICE_TABLE.models[DEFAULT_PRICE_TABLE.fallbackModel].off;
    const off = { ...base, ...(entry?.off ?? {}) };
    if (!Number.isFinite(Number((entry?.off as ModelRates | undefined)?.cacheWrite))) off.cacheWrite = off.cacheMiss;
    models[name] = { label: entry?.label ?? name, off };
  }
  const mult = numberOr(override.peakMultiplier, DEFAULT_PRICE_TABLE.peakMultiplier);
  return {
    version: numberOr(override.version, DEFAULT_PRICE_TABLE.version),
    currency: override.currency ?? DEFAULT_PRICE_TABLE.currency,
    symbol: override.symbol ?? DEFAULT_PRICE_TABLE.symbol,
    unit: numberOr(override.unit, DEFAULT_PRICE_TABLE.unit) || DEFAULT_PRICE_TABLE.unit,
    peakMultiplier: mult > 0 ? mult : DEFAULT_PRICE_TABLE.peakMultiplier,
    peakWindows: override.peakWindows ?? DEFAULT_PRICE_TABLE.peakWindows,
    peakWeekdays: override.peakWeekdays ?? DEFAULT_PRICE_TABLE.peakWeekdays,
    models,
    fallbackModel: DEFAULT_PRICE_TABLE.fallbackModel
  };
}

/**
 * 某一时刻、某个模型的实际单价（含高峰倍数与兜底标记）。
 *
 * 参数 `model`：模型名（可能为空 / 旧名 / 拼错）；`atMs`：采样时刻；`table`：价目表。
 * 返回：四个已乘倍率的单价 + 档位 + `estimated` 标记。
 * 边界：模型名为空或没在表里 → 用兜底模型的价格，并标 `estimated=true`。
 */
export function ratesAt(
  model: string | undefined,
  atMs: number,
  table: PriceTable = DEFAULT_PRICE_TABLE
): RatesAt {
  const fallback = table.models[table.fallbackModel];
  // 空模型名也算「没覆盖」：宁可标估算，也不要假装知道对方用的什么模型。
  const entry = (model && table.models[model]) || fallback;
  const estimated = !model || !table.models[model];
  const peak = isPeakAt(atMs, table);
  const factor = peak ? table.peakMultiplier : 1;
  const off = entry.off;
  return {
    model: model ?? table.fallbackModel,
    label: entry.label,
    tier: peak ? 'peak' : 'off',
    tierLabel: peak ? '高峰时段' : '空闲时段',
    estimated,
    currency: table.currency,
    symbol: table.symbol,
    cacheHit: off.cacheHit * factor,
    cacheMiss: off.cacheMiss * factor,
    cacheWrite: (Number.isFinite(off.cacheWrite) ? off.cacheWrite : off.cacheMiss) * factor,
    output: off.output * factor
  };
}

/**
 * 一条采样的金额明细（币种与档位随价目表/时刻走）。
 *
 * `total` 是四项之和，**不含**任何取整——显示取整在 `formatMoney` 里做，
 * 聚合时用未取整的值，避免每笔四舍五入后误差越滚越大。
 */
export interface UsageCost {
  cacheHit: number;
  cacheMiss: number;
  cacheWrite: number;
  output: number;
  total: number;
  currency: string;
  symbol: string;
  tier: PriceTier;
  tierLabel: string;
  estimated: boolean;
}

/**
 * 用四个桶乘四个单价，得到这条采样的金额。
 *
 * 参数 `buckets`：账本桶；`rates`：已经乘过倍率的有效单价；`table`：只为取 `unit`。
 * 返回：四项明细 + `total` + 币种/档位/估算标记（全部从 `rates` 透传）。
 * 边界：token 数不做二次取整；金额也不在这里取整，显示时才格式化。
 */
export function priceBuckets(
  buckets: UsageBuckets,
  rates: RatesAt,
  table: PriceTable = DEFAULT_PRICE_TABLE
): UsageCost {
  // 单价口径是「每 1e6 token」，所以先除 unit 再乘价；顺序别反，否则会放大误差。
  const per = (tokens: number, rate: number) => (tokens / table.unit) * rate;
  const cost = {
    cacheHit: per(buckets.cacheHit, rates.cacheHit),
    cacheMiss: per(buckets.cacheMiss, rates.cacheMiss),
    cacheWrite: per(buckets.cacheWrite, rates.cacheWrite),
    output: per(buckets.output, rates.output)
  };
  return {
    ...cost,
    total: cost.cacheHit + cost.cacheMiss + cost.cacheWrite + cost.output,
    currency: rates.currency,
    symbol: rates.symbol,
    tier: rates.tier,
    tierLabel: rates.tierLabel,
    estimated: rates.estimated
  };
}

/**
 * 一步到位的便捷函数：按发生时刻计价。
 *
 * 参数 `buckets`：账本桶；`options.at`：采样发生的毫秒时间戳（**必填**，缺省 0 只是为了让签名可选）。
 * `options.model` 决定用哪一行价目，`options.table` 可换成设置合并后的表。
 * 返回：`priceBuckets` 的结果。非有限的 `at` 按 0 处理（1970 年，必然空闲价）。
 */
export function priceUsage(
  buckets: UsageBuckets,
  options: { model?: string; at: number; table?: PriceTable } = { at: 0 }
): UsageCost {
  const table = options.table ?? DEFAULT_PRICE_TABLE;
  const at = Number.isFinite(options.at) ? options.at : 0;
  return priceBuckets(buckets, ratesAt(options.model, at, table), table);
}

/**
 * 金额显示：小于 1 分显示 4 位，否则 2 位；带币种符号。
 *
 * 参数 `value`：金额；`symbol`：币种符号；`digits`：强制小数位（给了就不按阈值猜）。
 * 返回：`¥0.0021` 这样的字符串；非有限数返回 `¥—`（不显示 NaN 或 Infinity）。
 * 边界：0 显示 `¥0.00`（`Math.abs(n) > 0` 的判断让 0 走 2 位，而不是 4 位）。
 */
export function formatMoney(value: number, symbol = '¥', digits?: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${symbol}—`;
  const fixed = digits ?? (Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2);
  return `${symbol}${n.toFixed(fixed)}`;
}

/**
 * token 显示：万/亿 分档，不丢量级。
 *
 * 参数 `value`：token 数；返回带「万 / 亿」的中文串（保留两位小数）。
 * 边界：非有限数返回 `—`；小于 1 万按整数显示（四舍五入到个位）。
 */
export function formatTokens(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)} 万`;
  return String(Math.round(n));
}
