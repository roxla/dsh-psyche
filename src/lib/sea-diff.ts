import type { SeaNode, SeaScene } from './sea.js'

/** A previous visit snapshot, stored only in the browser. */
export interface SeaVisitSnapshot {
  at: string
  fingerprint: string
  instanceKey: string
}

/** A node's change relative to the previous visit. */
export type SeaDiffKind = 'new' | 'updated'

/**
 * Pure comparison of one node against the previous visit time.
 * `new` wins over `updated`; missing/invalid timestamps never produce a mark.
 */
export function classifyDiff(prev: SeaVisitSnapshot | null, node: Pick<SeaNode, 'createdAt' | 'revisedAt'>): SeaDiffKind | null {
  if (!prev) return null
  const seenAt = Date.parse(prev.at)
  if (!Number.isFinite(seenAt)) return null
  const created = node.createdAt ? Date.parse(node.createdAt) : NaN
  if (Number.isFinite(created) && created > seenAt) return 'new'
  const revised = node.revisedAt ? Date.parse(node.revisedAt) : NaN
  if (Number.isFinite(revised) && revised > seenAt) return 'updated'
  return null
}

/** Opaque structure marker; changes whenever the visible data or window changes. */
export function fingerprint(scene: Pick<SeaScene, 'stats'>): string {
  const totalArtifacts = Number(scene.stats?.totalArtifacts) || 0
  const totalEvents = Number(scene.stats?.totalEvents) || 0
  const to = scene.stats?.span?.to ?? ''
  return `${totalArtifacts}:${totalEvents}:${to}`
}

/**
 * True when the previous snapshot cannot be trusted for this scene.
 * The client should then clear lastVisit and treat the visit as first.
 */
export function shouldReset(prev: SeaVisitSnapshot | null, scene: Pick<SeaScene, 'instanceKey' | 'diffAvailable' | 'stats'>): boolean {
  if (!scene.diffAvailable || !scene.instanceKey) return true
  if (!prev) return true
  if (prev.instanceKey !== scene.instanceKey) return true
  if (!/^\d+:\d+:.+$/.test(prev.fingerprint)) return true
  return false
}
