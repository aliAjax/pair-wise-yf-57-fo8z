import type { PatrolState, Review, ReviewTarget, SampleSegment } from './types';

export function latestReview(state: PatrolState, targetType: ReviewTarget, targetKey: string): Review | undefined {
  return state.reviewHistory
    .filter((r) => r.targetType === targetType && r.targetKey === targetKey)
    .sort((a, b) => b.version - a.version)[0];
}

export function voidedIds(state: PatrolState): Set<string> {
  return new Set(state.voids.map((v) => v.segmentId));
}

export function voidReason(state: PatrolState, segmentId: string): string | undefined {
  return state.voids.find((v) => v.segmentId === segmentId)?.reason;
}

export function orderedTracks(state: PatrolState) {
  return [...state.tracks].sort((a, b) => a.ordinal - b.ordinal);
}
export function orderedObservations(state: PatrolState) {
  return [...state.observations].sort((a, b) => b.ordinal - a.ordinal);
}
export function orderedSegments(state: PatrolState, code: string): SampleSegment[] {
  return state.segments.filter((s) => s.sampleCode === code).sort((a, b) => a.ordinal - b.ordinal);
}
export function shortHash(h: string): string {
  return h === 'GENESIS' ? '起点' : h.slice(0, 6);
}
export function pendingPackets(state: PatrolState) {
  return state.outbound.filter((p) => !p.firstResult).sort((a, b) => (a.deviceId === b.deviceId ? a.seq - b.seq : a.deviceId.localeCompare(b.deviceId)));
}
export function processedPackets(state: PatrolState) {
  return state.outbound.filter((p) => p.firstResult);
}
