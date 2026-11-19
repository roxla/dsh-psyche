// 心灵**自己**的模型调用账本（只记插件内部发起的调用，不记对话本身）。
//
// 为什么要单独一本账：面板「用量与花费」以前直接汇总宿主所有活会话的 `assistant/message.usage`，
// 那等于整个 agent 的消耗——跟「心灵这个插件花了多少」是两件事。用户明确要求只统计本插件
// 自己发起的调用（日记 Writer、以后的人格自述/摘要等），所以改成插件内部记账：
//
//   - 谁调用模型，谁在调用后 `recordSelfCall()` 记一条；
//   - 记的是**派生结果**（归一化后的四个 token 桶 + 时刻 + 模型 + 用途），不持有宿主对象；
//   - 进程内内存账本，重启即清零。刻意不落库：用量不是记忆，不该进 events/operations，
//     也不该让「删库」变成「删账单」的副作用。
//
// 不变量：同一笔调用只记一次；`aggregateUsage()` 拿到的永远是纯数据。

import { sampleOf, type UsageSample } from './usage.js';

/** 一条插件自用采样：在通用采样上多一个 `purpose`（用途标签，给人看的，不参与计价）。 */
export interface SelfUsageEntry extends UsageSample {
  /** 用途：`diary` / `reflection` / `summary` … 由调用方给，缺省 undefined。 */
  purpose?: string;
}

/**
 * 记账上限：进程内保留最近 5000 条。
 *
 * 为什么是 5000：一次日记生成 = 1 条，一天最多几条，5000 条够跑好几年；
 * 真到了上限说明有人在循环调用，那时丢掉最老的比吃满内存好。
 */
export const MAX_ENTRIES = 5000;

/** 记一条调用需要的入参（`usage` 是宿主给的原始 usage 对象，这里再归一化一次）。 */
export interface RecordOptions {
  usage: unknown;
  model?: string;
  purpose?: string;
  at?: number;
  sessionId?: string;
  turn?: number;
  step?: number;
}

/**
 * 插件内部模型调用的内存账本。
 *
 * 有状态（像已下线的 `UsageCollector` 一样是例外）：账本本身就是要跨请求累积的东西。
 * 但它只存派生数据，`reset()` 一把清空，不泄漏任何宿主对象。
 */
export class SelfUsageLedger {
  #entries: SelfUsageEntry[] = [];

  /** 记一条调用，返回落账的那一条（已归一化）；`usage` 全是 0 时也照样记——调用发生过就是事实。 */
  record(options: RecordOptions): SelfUsageEntry {
    const entry: SelfUsageEntry = {
      ...sampleOf({
        usage: options.usage,
        model: options.model,
        at: options.at ?? Date.now(),
        sessionId: options.sessionId ?? 'psyche',
        turn: options.turn,
        step: options.step
      }),
      purpose: options.purpose
    };
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) {
      // 一次裁掉最老的那一截（不是只裁 1 条），避免每条都触发数组复制。
      this.#entries = this.#entries.slice(this.#entries.length - MAX_ENTRIES);
    }
    return entry;
  }

  /** 全部采样（按记录顺序；聚合层会再排序）。返回副本，调用方改不动账本。 */
  samples(): SelfUsageEntry[] {
    return this.#entries.slice();
  }

  /** 记了几条。 */
  get count(): number {
    return this.#entries.length;
  }

  /** 清空（重载/撤销时用）。 */
  reset(): void {
    this.#entries = [];
  }
}

/**
 * 便捷函数：给一个「调用后记一笔」的回调，调用方不用自己拼字段。
 *
 * 用法（未来的日记 Writer）：
 * ```ts
 * const usage = await this.#stream(...) // 拿到 usage
 * recordSelfCall(ledger, { usage, model, purpose: 'diary' })
 * ```
 */
export function recordSelfCall(ledger: SelfUsageLedger, options: RecordOptions): SelfUsageEntry {
  return ledger.record(options);
}
