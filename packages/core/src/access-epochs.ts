// 授权代次的策略侧持久化（迁移 36）。
//
// 为什么要有这个文件：v29.29 的代次只活在桥接的 `#accessEpochs` 里，v29.30 把代次
// 写进了任务行，但没有解决「重启后桥接从 0 重新计数」——那时库里某个 peer 的
// `access_epoch` 可能是 3，而桥接算出来是 0，所有在途回复都会被判
// `access-superseded`。比误发安全，但会让重启后的回复静默失败，用户看到的是
// 「重启之后他就不理我了」。
//
// 三条纪律：
// 1. **只增不减。** 撤销也保留记录、`epoch + 1`，重新授权继续往上走。回到 0 会让
//    「上一段授权下开工的任务」重新变成合法。
// 2. **按 peer_key 分。** 与桥接的 Map 同构（`private:<userId>` / `group:<groupId>`），
//    加 C 不影响 B。
// 3. **读不出来就照实报错。** 桥接拿不到这份记录时不能假装「大家都是第 0 代」，
//    那等于把上面那个静默失败变成默认行为；调用方应当按 `null` 处理并暂停派发。

/** 只要求最小接口，测试可以直接给一个内存实现。 */
export interface AccessEpochDb {
  get(sql: string, params?: readonly unknown[]): unknown
  all(sql: string, params?: readonly unknown[]): unknown[]
  run(sql: string, params?: readonly unknown[]): void
}

export interface AccessEpochRow {
  readonly peerKey: string
  readonly epoch: number
}

/** 读出某个 persona 下所有 peer 的当前代次；没有记录就是空 Map（真·第一次）。 */
export function loadAccessEpochs(db: AccessEpochDb, personaId: string): Map<string, number> {
  const rows = db.all(
    'SELECT peer_key, epoch FROM access_epochs WHERE persona_id = ? ORDER BY peer_key',
    [personaId],
  ) as { peer_key?: unknown; epoch?: unknown }[]
  const out = new Map<string, number>()
  for (const row of rows) {
    if (typeof row.peer_key !== 'string' || row.peer_key === '') continue
    if (typeof row.epoch !== 'number' || !Number.isFinite(row.epoch) || row.epoch < 0) continue
    out.set(row.peer_key, row.epoch)
  }
  return out
}

export interface SaveAccessEpochsInput {
  readonly db: AccessEpochDb
  readonly personaId: string
  /** 桥接当前的完整代次表；只写有变化的行，未出现的不删除（撤销也要保留记录）。 */
  readonly epochs: ReadonlyMap<string, number>
  readonly now: string
}

/**
 * 把桥接的代次表落库。整体在一个事务里，避免「涨到一半断电」留下半个世界。
 * 返回实际写入的行数（测试用来断言「重复保存不写库」）。
 */
export function saveAccessEpochs(input: SaveAccessEpochsInput): number {
  const { db, personaId, epochs, now } = input
  const existing = loadAccessEpochs(db, personaId)
  const changed: [string, number][] = []
  for (const [peerKey, epoch] of epochs) {
    if (peerKey === '') continue
    if (!Number.isInteger(epoch) || epoch < 0) continue
    const before = existing.get(peerKey)
    if (before === epoch) continue
    // 只增不减：库里的值更大时保留库里的，避免并发写把代次拉回去。
    if (before !== undefined && before > epoch) continue
    changed.push([peerKey, epoch])
  }
  if (changed.length === 0) return 0
  db.run('BEGIN IMMEDIATE')
  try {
    for (const [peerKey, epoch] of changed) {
      db.run(
        `INSERT INTO access_epochs (persona_id, peer_key, epoch, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(persona_id, peer_key) DO UPDATE SET
           epoch = excluded.epoch,
           updated_at = excluded.updated_at
         WHERE excluded.epoch > access_epochs.epoch`,
        [personaId, peerKey, epoch, now],
      )
    }
    db.run('COMMIT')
  } catch (error) {
    db.run('ROLLBACK')
    throw error
  }
  return changed.length
}

/** 单个 peer 的当前代次；没有记录返回 null（调用方应据此暂停派发，不要当成 0）。 */
export function accessEpochOf(db: AccessEpochDb, personaId: string, peerKey: string): number | null {
  const row = db.get('SELECT epoch FROM access_epochs WHERE persona_id = ? AND peer_key = ?', [personaId, peerKey]) as
    | { epoch?: unknown }
    | undefined
  if (row === undefined) return null
  return typeof row.epoch === 'number' && Number.isFinite(row.epoch) && row.epoch >= 0 ? row.epoch : null
}

// ── 两阶段提交（迁移 37） ────────────────────────────────────────────────
//
// 名单写覆盖文件、代次写 SQLite，两个位置不是同一时刻落盘。崩溃点落在「覆盖文件
// 已写、代次还没落库」时，重启后读到的组合是「名单里有人 + 代次还是旧的」——如果
// 这中间发生过「撤销 → 重新授权」，那个旧代次恰好又变成合法值，撤销前开工的任务
// 就会恢复发送资格。这不是偏保守，是放行。
//
// 所以：**先记 pending，再让人写名单，最后确认**。重启时 pending 里还有谁，就是
// 「上一次变更没走完」，那个对象一律暂停，等人重新授权一次（会走完整流程并清掉）。

/** 读出「上次没走完的授权变更」；非空即这些 peer 在确认前不得派遣。 */
export function loadPendingEpochs(db: AccessEpochDb, personaId: string): Map<string, number> {
  const rows = db.all(
    'SELECT peer_key, target_epoch FROM access_epoch_pending WHERE persona_id = ? ORDER BY peer_key',
    [personaId],
  ) as { peer_key?: unknown; target_epoch?: unknown }[]
  const out = new Map<string, number>()
  for (const row of rows) {
    if (typeof row.peer_key !== 'string' || row.peer_key === '') continue
    if (typeof row.target_epoch !== 'number' || !Number.isFinite(row.target_epoch)) continue
    out.set(row.peer_key, row.target_epoch)
  }
  return out
}

export interface BeginAccessEpochChangeInput {
  readonly db: AccessEpochDb
  readonly personaId: string
  /** 这次变更要让哪些 peer 涨到几代。空表直接返回 0（没有任何变更要记）。 */
  readonly targets: ReadonlyMap<string, number>
  readonly now: string
}

/**
 * 第一阶段：把「打算涨到几代」落盘。**这一步失败就必须放弃整次名单变更**——
 * 否则覆盖文件已经改了、却没人记得这次变更还没完成，重启后就回到那个放行组合。
 * 返回写入的行数。
 */
export function beginAccessEpochChange(input: BeginAccessEpochChangeInput): number {
  const { db, personaId, targets, now } = input
  if (targets.size === 0) return 0
  db.run('BEGIN IMMEDIATE')
  try {
    let written = 0
    for (const [peerKey, target] of targets) {
      if (peerKey === '') continue
      if (!Number.isInteger(target) || target < 0) continue
      db.run(
        `INSERT INTO access_epoch_pending (persona_id, peer_key, target_epoch, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(persona_id, peer_key) DO UPDATE SET
           target_epoch = excluded.target_epoch,
           created_at = excluded.created_at`,
        [personaId, peerKey, target, now],
      )
      written += 1
    }
    db.run('COMMIT')
    return written
  } catch (error) {
    db.run('ROLLBACK')
    throw error
  }
}

export interface CommitAccessEpochChangeInput {
  readonly db: AccessEpochDb
  readonly personaId: string
  readonly epochs: ReadonlyMap<string, number>
  readonly now: string
}

/**
 * 第三阶段：提交代次并清掉这些 peer 的 pending。两件事必须在同一个事务里——
 * 「代次写进去、pending 没删」会让下次重启继续暂停（偏保守但会误伤），
 * 「pending 删了、代次没写」则直接回到放行组合。
 * 返回实际写入的代次行数。
 */
export function commitAccessEpochChange(input: CommitAccessEpochChangeInput): number {
  const { db, personaId, epochs, now } = input
  const existing = loadAccessEpochs(db, personaId)
  const changed: [string, number][] = []
  for (const [peerKey, epoch] of epochs) {
    if (peerKey === '') continue
    if (!Number.isInteger(epoch) || epoch < 0) continue
    const before = existing.get(peerKey)
    if (before === epoch) continue
    if (before !== undefined && before > epoch) continue
    changed.push([peerKey, epoch])
  }
  db.run('BEGIN IMMEDIATE')
  try {
    for (const [peerKey, epoch] of changed) {
      db.run(
        `INSERT INTO access_epochs (persona_id, peer_key, epoch, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(persona_id, peer_key) DO UPDATE SET
           epoch = excluded.epoch,
           updated_at = excluded.updated_at
         WHERE excluded.epoch > access_epochs.epoch`,
        [personaId, peerKey, epoch, now],
      )
    }
    for (const peerKey of epochs.keys()) {
      db.run('DELETE FROM access_epoch_pending WHERE persona_id = ? AND peer_key = ?', [personaId, peerKey])
    }
    db.run('COMMIT')
  } catch (error) {
    db.run('ROLLBACK')
    throw error
  }
  return changed.length
}
