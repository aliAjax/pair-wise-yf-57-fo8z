/**
 * 离线巡护包接收引擎（纯函数，便于自测）。
 *
 * 规则总览：
 * 1. 包幂等：(deviceId, patrolId, packageSeq) 唯一；重传整包直接沿用第一次报告，不落任何新数据。
 * 2. 事件幂等：eventId = deviceId + patrolId + 设备连续序号；重传条目沿用第一次处理结果。
 * 3. 业务键去重：观察按内容/时间/地点判同，轨迹按设备+序号判同，交接按环节判同。
 *    去重和重放都不更新既有记录 —— 因此“旧包”不可能顶掉负责人已给出的结论。
 * 4. 顺序只信连续序号，不信设备时钟；时钟回拨只产生告警。
 * 5. 样本交接链只追加（采集→交接→送检），每条带 prevHash/hash；
 *    退回在样本自己的链上追加退回点，退回期间该样本的后续交接逐条自动作废，
 *    其他样本不受影响；补齐后追加 resume 记录，从退回点继续。
 * 6. 单条事件失败（含异常）不影响同包其他条目。
 */

import { eventId, keyOfEvent, packageId, trackKeyOf } from './keys';
import { hashStable } from './crypto';
import type {
  CustodyEntry, IngestedObservation, IngestedTrack, IngestReport, ItemResult,
  OfflinePackage, PackageEvent, ReviewDecision, ReviewFlags, SampleRecord
} from './types';

export interface ActiveReturn {
  reviewId: string;
  markerChainSeq: number;
  reasons: string[];
  requiredMaterials: string[];
  at: string;
}

export interface IngestState {
  patrolId: string;
  receiveCounter: number;
  reportCounter: number;
  /** `${patrolId}|${deviceId}` -> 已收到的最大连续包序号 */
  lastPackageSeq: Record<string, number>;
  /** `${patrolId}|${deviceId}` -> 已收到的最大连续事件序号 */
  maxEventSeq: Record<string, number>;
  /** `${patrolId}|${deviceId}` -> 见过的最大设备时间（用于识别回拨） */
  lastDeviceTime: Record<string, string>;
  observations: IngestedObservation[];
  tracks: IngestedTrack[];
  samples: SampleRecord[];
  custody: CustodyEntry[];
  /** sampleCode -> 当前生效的退回（补齐后删除） */
  activeReturns: Record<string, ActiveReturn>;
  reviews: ReviewDecision[];
  /** eventId -> 该事件第一次处理结果 */
  processedEvents: Record<string, ItemResult>;
  reports: IngestReport[];
}

export function createState(patrolId: string): IngestState {
  return {
    patrolId,
    receiveCounter: 0,
    reportCounter: 0,
    lastPackageSeq: {},
    maxEventSeq: {},
    lastDeviceTime: {},
    observations: [],
    tracks: [],
    samples: [],
    custody: [],
    activeReturns: {},
    reviews: [],
    processedEvents: {},
    reports: []
  };
}

const GENESIS = (sampleCode: string) => `genesis:${sampleCode}`;

function nextReceiveOrder(state: IngestState): number {
  state.receiveCounter += 1;
  return state.receiveCounter;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ---------------- 交接链 ---------------- */

function lastCustody(state: IngestState, sampleCode: string): CustodyEntry | undefined {
  let found: CustodyEntry | undefined;
  for (const entry of state.custody) {
    if (entry.sampleCode === sampleCode && (!found || entry.chainSeq > found.chainSeq)) found = entry;
  }
  return found;
}

/** 追加一条交接记录，计算哈希链。 */
function appendCustody(
  state: IngestState,
  fields: Omit<CustodyEntry, 'chainSeq' | 'prevHash' | 'hash'>
): CustodyEntry {
  const prev = lastCustody(state, fields.sampleCode);
  const chainSeq = prev ? prev.chainSeq + 1 : 1;
  const prevHash = prev ? prev.hash : hashStable(GENESIS(fields.sampleCode));
  const draft: Omit<CustodyEntry, 'hash'> = { ...fields, chainSeq, prevHash };
  const hash = hashStable({ ...draft, hash: undefined });
  const entry: CustodyEntry = { ...draft, hash };
  state.custody.push(entry);
  return entry;
}

/** 校验某样本的交接链：历史被改动时哈希对不上。 */
export function verifyChain(state: IngestState, sampleCode: string): { ok: boolean; brokenAt?: number } {
  const entries = state.custody
    .filter((entry) => entry.sampleCode === sampleCode)
    .sort((a, b) => a.chainSeq - b.chainSeq);
  let prevHash = hashStable(GENESIS(sampleCode));
  for (const entry of entries) {
    if (entry.prevHash !== prevHash) return { ok: false, brokenAt: entry.chainSeq };
    const expected = hashStable({ ...entry, hash: undefined });
    if (entry.hash !== expected) return { ok: false, brokenAt: entry.chainSeq };
    prevHash = entry.hash;
  }
  return { ok: true };
}

/* ---------------- 复核辅助 ---------------- */

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const lat1 = rad(a.latitude);
  const lat2 = rad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const LOCATION_LIMIT_METERS = 1500;

/** 按“能力范围 / 位置异常 / 缺失证据”三维度给出机器初判。 */
export function detectFlags(obs: IngestedObservation, tracks: IngestedTrack[]): ReviewFlags {
  const missingEvidence = obs.evidenceIds.length === 0;
  const capability = obs.outOfCapability;
  let location = false;
  if (obs.latitude === undefined || obs.longitude === undefined) {
    location = obs.risk !== 'low'; // 中高风险却没有定位
  } else if (tracks.length > 0) {
    const nearest = Math.min(...tracks.map((point) =>
      haversineMeters({ latitude: obs.latitude!, longitude: obs.longitude! }, point)));
    location = nearest > LOCATION_LIMIT_METERS;
  }
  return { capability, location, missingEvidence };
}

export function flagReasons(flags: ReviewFlags): string[] {
  const reasons: string[] = [];
  if (flags.capability) reasons.push('超出巡护员能力范围，需专业鉴定');
  if (flags.location) reasons.push('位置异常：缺少定位或偏离巡护轨迹');
  if (flags.missingEvidence) reasons.push('证据缺失：未附现场材料');
  return reasons;
}

export function latestReview(state: IngestState, target: 'observation' | 'sample', refKey: string): ReviewDecision | undefined {
  let found: ReviewDecision | undefined;
  for (const review of state.reviews) {
    if (review.target === target && review.refKey === refKey && (!found || review.revision > found.revision)) {
      found = review;
    }
  }
  return found;
}

function nextRevision(state: IngestState, target: 'observation' | 'sample', refKey: string): number {
  return state.reviews.filter((review) => review.target === target && review.refKey === refKey).length + 1;
}

/* ---------------- 负责人复核（结论只追加） ---------------- */

export interface ObservationReviewInput {
  obsKey: string;
  verdict: 'approved' | 'returned';
  reviewer: string;
  reasons: string[];
  requiredMaterials: string[];
}

export function reviewObservation(state: IngestState, input: ObservationReviewInput): ReviewDecision {
  const decision: ReviewDecision = {
    id: `rv-${state.reviews.length + 1}-${Date.now()}`,
    target: 'observation',
    refKey: input.obsKey,
    verdict: input.verdict,
    reasons: input.reasons,
    requiredMaterials: input.requiredMaterials,
    reviewer: input.reviewer,
    decidedAt: nowIso(),
    revision: nextRevision(state, 'observation', input.obsKey)
  };
  state.reviews.push(decision);
  return decision;
}

export interface SampleReturnInput {
  sampleCode: string;
  reviewer: string;
  reasons: string[];
  requiredMaterials: string[];
}

/** 退回：只在受影响样本的链上追加退回点，其他样本与既有记录一律不动。 */
export function returnSample(state: IngestState, input: SampleReturnInput): ReviewDecision {
  const sample = state.samples.find((item) => item.sampleCode === input.sampleCode);
  if (!sample) throw new Error(`样本 ${input.sampleCode} 不存在`);
  if (state.activeReturns[input.sampleCode]) throw new Error(`样本 ${input.sampleCode} 已在退回中，请先补齐`);

  const decision: ReviewDecision = {
    id: `rv-${state.reviews.length + 1}-${Date.now()}`,
    target: 'sample',
    refKey: input.sampleCode,
    verdict: 'returned',
    reasons: input.reasons,
    requiredMaterials: input.requiredMaterials,
    reviewer: input.reviewer,
    decidedAt: nowIso(),
    revision: nextRevision(state, 'sample', input.sampleCode)
  };
  state.reviews.push(decision);

  const marker = appendCustody(state, {
    eventId: `return:${input.sampleCode}:${decision.revision}`,
    sampleCode: input.sampleCode,
    patrolId: state.patrolId,
    deviceId: 'reviewer',
    deviceSeq: 0,
    deviceTime: decision.decidedAt,
    receivedOrder: nextReceiveOrder(state),
    type: 'void',
    reason: `退回点：${input.reasons.join('；') || '负责人退回'}`,
    evidenceIds: [],
    reviewId: decision.id
  });

  state.activeReturns[input.sampleCode] = {
    reviewId: decision.id,
    markerChainSeq: marker.chainSeq,
    reasons: input.reasons,
    requiredMaterials: input.requiredMaterials,
    at: decision.decidedAt
  };
  return decision;
}

export interface SampleResumeInput {
  sampleCode: string;
  reviewer: string;
  note: string;
  /** 补齐补交的材料编号 */
  supplementaryEvidence: string[];
}

/** 补齐：追加 resume 记录并解除退回，交接链从退回点继续。 */
export function resumeSample(state: IngestState, input: SampleResumeInput): ReviewDecision {
  const active = state.activeReturns[input.sampleCode];
  if (!active) throw new Error(`样本 ${input.sampleCode} 没有待处理的退回`);

  const decision: ReviewDecision = {
    id: `rv-${state.reviews.length + 1}-${Date.now()}`,
    target: 'sample',
    refKey: input.sampleCode,
    verdict: 'approved',
    reasons: [`材料补齐：${input.note}`],
    requiredMaterials: [],
    reviewer: input.reviewer,
    decidedAt: nowIso(),
    revision: nextRevision(state, 'sample', input.sampleCode)
  };
  state.reviews.push(decision);

  appendCustody(state, {
    eventId: `resume:${input.sampleCode}:${decision.revision}`,
    sampleCode: input.sampleCode,
    patrolId: state.patrolId,
    deviceId: 'reviewer',
    deviceSeq: 0,
    deviceTime: decision.decidedAt,
    receivedOrder: nextReceiveOrder(state),
    type: 'resume',
    reason: active.reasons.join('；'),
    resumeNote: input.note,
    evidenceIds: input.supplementaryEvidence,
    reviewId: decision.id
  });

  delete state.activeReturns[input.sampleCode];
  return decision;
}

/* ---------------- 旧设备 / 升级前记录 ---------------- */

export interface LegacySampleInput {
  sampleCode: string;
  species: string;
  count: number;
  collectorId: string;
  collectorName: string;
  /** 旧记录只剩采集时间 */
  collectedAt: string;
}

/**
 * 导入升级前的旧记录：只有采集人和采集时间，证据/设备序列均缺失。
 * 仍然为它建立交接链起点，升级后可以正常查看和继续交接。
 */
export function importLegacySample(state: IngestState, input: LegacySampleInput): CustodyEntry {
  if (state.samples.some((item) => item.sampleCode === input.sampleCode)) {
    throw new Error(`样本 ${input.sampleCode} 已存在`);
  }
  const sample: SampleRecord = {
    sampleCode: input.sampleCode,
    species: input.species,
    count: input.count,
    collectorId: input.collectorId,
    collectorName: input.collectorName,
    collectedAt: input.collectedAt,
    legacy: true
  };
  state.samples.push(sample);
  return appendCustody(state, {
    eventId: `legacy:${input.sampleCode}`,
    sampleCode: input.sampleCode,
    patrolId: state.patrolId,
    deviceId: 'legacy-device',
    deviceSeq: 0,
    deviceTime: input.collectedAt,
    receivedOrder: nextReceiveOrder(state),
    type: 'collect',
    collectorId: input.collectorId,
    collectorName: input.collectorName,
    species: input.species,
    count: input.count,
    evidenceIds: [],
    legacy: true
  });
}

/* ---------------- 单条事件处理 ---------------- */

type PartialResult = Omit<ItemResult, 'eventId' | 'kind' | 'seq'>;

const fail = (reasonCode: string, message: string, requiredMaterials?: string[]): PartialResult =>
  ({ status: 'failed', reasonCode, message, requiredMaterials });

function applyEvent(state: IngestState, pkg: OfflinePackage, event: PackageEvent): PartialResult {
  const { deviceId, patrolId } = pkg;
  const eid = eventId(deviceId, patrolId, event.seq);

  // 事件级重传：沿用第一次处理结果，不重新判定、不覆盖任何数据。
  const first = state.processedEvents[eid];
  if (first) {
    return {
      status: 'replayed',
      existingKey: first.existingKey,
      requiredMaterials: first.requiredMaterials,
      reasonCode: first.reasonCode,
      message: `重传沿用第一次结果（${statusLabel(first.status)}）${first.message ? `：${first.message}` : ''}`
    };
  }

  const key = keyOfEvent(deviceId, event);
  const order = nextReceiveOrder(state);

  switch (event.kind) {
    case 'observation': {
      if (!event.note.trim()) return fail('EMPTY_NOTE', '观察内容为空，无法入库');
      const existing = state.observations.find((item) => item.key === key);
      if (existing) {
        return {
          status: 'skipped',
          reasonCode: 'DUP_BUSINESS_KEY',
          existingKey: existing.key,
          message: '与既有观察是同一条（同内容/时间/地点），按业务键去重'
        };
      }
      const record: IngestedObservation = {
        key,
        patrolId,
        deviceId,
        seq: event.seq,
        eventId: eid,
        deviceTime: event.clock.deviceTime,
        serverTimeAtBoot: event.clock.serverTimeAtBoot,
        receivedOrder: order,
        note: event.note,
        risk: event.risk,
        evidenceIds: event.evidenceIds,
        outOfCapability: event.outOfCapability,
        sampleCode: event.sampleCode,
        latitude: event.latitude,
        longitude: event.longitude
      };
      state.observations.push(record);
      return { status: 'applied', existingKey: key, message: '观察已入库' };
    }

    case 'track': {
      if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) {
        return fail('INVALID_COORDS', '轨迹点坐标不是有效数字');
      }
      const key2 = trackKeyOf(deviceId, event);
      const existing = state.tracks.find((item) => item.key === key2);
      if (existing) {
        return {
          status: 'skipped',
          reasonCode: 'DUP_BUSINESS_KEY',
          existingKey: existing.key,
          message: '同一设备同一序号的轨迹点已存在，按业务键去重'
        };
      }
      const record: IngestedTrack = {
        key: key2,
        patrolId,
        deviceId,
        seq: event.seq,
        eventId: eid,
        deviceTime: event.clock.deviceTime,
        receivedOrder: order,
        latitude: event.latitude,
        longitude: event.longitude,
        source: event.source,
        deltaMeters: event.deltaMeters
      };
      state.tracks.push(record);
      return { status: 'applied', existingKey: key2, message: '轨迹点已入库' };
    }

    case 'collect': {
      if (!event.sampleCode.trim()) return fail('EMPTY_SAMPLE_CODE', '样本编号为空');
      if (!Number.isFinite(event.count) || event.count <= 0) return fail('INVALID_COUNT', '样本数量必须大于 0');
      if (!event.collectorId.trim() || !event.collectorName.trim()) {
        return fail('MISSING_COLLECTOR', '缺少采集人信息');
      }
      const existingSample = state.samples.find((item) => item.sampleCode === event.sampleCode);
      if (existingSample) {
        return {
          status: 'skipped',
          reasonCode: 'DUP_BUSINESS_KEY',
          existingKey: event.sampleCode,
          message: `样本 ${event.sampleCode} 已采集，重复采集按业务键去重`
        };
      }
      state.samples.push({
        sampleCode: event.sampleCode,
        species: event.species,
        count: event.count,
        collectorId: event.collectorId,
        collectorName: event.collectorName,
        collectedAt: event.clock.deviceTime
      });
      appendCustody(state, {
        eventId: eid,
        sampleCode: event.sampleCode,
        patrolId,
        deviceId,
        deviceSeq: event.seq,
        deviceTime: event.clock.deviceTime,
        receivedOrder: order,
        type: 'collect',
        collectorId: event.collectorId,
        collectorName: event.collectorName,
        species: event.species,
        count: event.count,
        evidenceIds: event.evidenceIds
      });
      return { status: 'applied', existingKey: event.sampleCode, message: `样本 ${event.sampleCode} 采集记录已入库` };
    }

    case 'handover': {
      if (!event.sampleCode.trim()) return fail('EMPTY_SAMPLE_CODE', '交接记录缺少样本编号');
      if (!event.toPersonId.trim() || !event.toPersonName.trim()) {
        return fail('MISSING_HANDOVER_TARGET', '交接缺少接收人');
      }
      const sample = state.samples.find((item) => item.sampleCode === event.sampleCode);
      if (!sample) {
        return fail('SAMPLE_NOT_COLLECTED', `样本 ${event.sampleCode} 尚未采集，交接环节不能成立`, ['样本采集记录']);
      }
      const active = state.activeReturns[event.sampleCode];
      if (active) {
        // 退回期间：后续交接逐条自动作废，并在链上留下不可改的作废记录。
        appendCustody(state, {
          eventId: eid,
          sampleCode: event.sampleCode,
          patrolId,
          deviceId,
          deviceSeq: event.seq,
          deviceTime: event.clock.deviceTime,
          receivedOrder: order,
          type: 'void',
          fromPersonId: event.fromPersonId,
          toPersonId: event.toPersonId,
          toPersonName: event.toPersonName,
          destination: event.destination,
          evidenceIds: event.evidenceIds,
          reason: '样本退回期间的后续交接，自动作废',
          reviewId: active.reviewId
        });
        return {
          status: 'auto-voided',
          reasonCode: 'VOID_AFTER_RETURN',
          existingKey: event.sampleCode,
          requiredMaterials: active.requiredMaterials,
          message: `样本处于退回态（退回点 #${active.markerChainSeq}），本次交接已作废，补齐后从退回点继续`
        };
      }
      const hFrom = event.fromPersonId;
      const existing = state.custody.find(
        (entry) => entry.type === 'handover' &&
          entry.sampleCode === event.sampleCode &&
          entry.fromPersonId === hFrom &&
          entry.toPersonId === event.toPersonId &&
          entry.destination === event.destination
      );
      if (existing) {
        return {
          status: 'skipped',
          reasonCode: 'DUP_BUSINESS_KEY',
          existingKey: event.sampleCode,
          message: '同一环节的交接已存在，按业务键去重'
        };
      }
      appendCustody(state, {
        eventId: eid,
        sampleCode: event.sampleCode,
        patrolId,
        deviceId,
        deviceSeq: event.seq,
        deviceTime: event.clock.deviceTime,
        receivedOrder: order,
        type: 'handover',
        fromPersonId: event.fromPersonId,
        toPersonId: event.toPersonId,
        toPersonName: event.toPersonName,
        destination: event.destination,
        evidenceIds: event.evidenceIds
      });
      return { status: 'applied', existingKey: event.sampleCode, message: `交接给 ${event.toPersonName}（${event.destination}）已记录` };
    }
  }
}

export function statusLabel(status: ItemResult['status']): string {
  switch (status) {
    case 'applied': return '已入库';
    case 'replayed': return '重传沿用';
    case 'skipped': return '去重跳过';
    case 'failed': return '失败';
    case 'auto-voided': return '自动作废';
  }
}

/* ---------------- 整包接收 ---------------- */

export interface IngestOutcome {
  state: IngestState;
  report: IngestReport;
}

/** 接收一个离线巡护包，返回新状态和逐条报告（不修改入参状态）。 */
export function ingestPackage(prev: IngestState, pkg: OfflinePackage): IngestOutcome {
  const state: IngestState = structuredClone(prev);
  const pid = packageId(pkg);
  const ingestedAt = nowIso();

  // 包级重传：整包沿用第一次报告。
  const firstReport = state.reports.find((report) => report.packageId === pid);
  if (firstReport) {
    return { state, report: { ...firstReport, packageReplayed: true, ingestedAt } };
  }

  const warnings: IngestReport['packageWarnings'] = [];
  const deviceKey = `${pkg.patrolId}|${pkg.deviceId}`;
  const expectedPackageSeq = (state.lastPackageSeq[deviceKey] ?? 0) + 1;

  if (pkg.packageSeq < expectedPackageSeq) {
    warnings.push({
      code: 'OUT_OF_ORDER_PACKAGE',
      message: `旧包晚到：本包序号 ${pkg.packageSeq}，此前已收到 #${expectedPackageSeq - 1}；旧包不会覆盖新数据`
    });
  } else if (pkg.packageSeq > expectedPackageSeq) {
    const missing: string[] = [];
    for (let n = expectedPackageSeq; n < pkg.packageSeq; n += 1) missing.push(`#${n}`);
    warnings.push({ code: 'PACKAGE_GAP', message: `缺失巡护包 ${missing.join('、')}，请设备补传` });
  }

  // 包内事件按连续序号排序处理（不信设备时间顺序）。
  const sorted = [...pkg.events].sort((a, b) => a.seq - b.seq);
  if (pkg.events.some((event, index) => index > 0 && pkg.events[index - 1].seq >= event.seq)) {
    warnings.push({ code: 'EVENTS_UNSORTED', message: '包内事件未按连续序号排列，已自动按序号排序处理' });
  }

  const seenSeq = new Set<number>();
  const prevMaxSeq = state.maxEventSeq[deviceKey] ?? 0;
  const incomingSeqs = sorted.map((event) => event.seq);
  const gapSeqs: number[] = [];
  if (incomingSeqs.length > 0) {
    const from = prevMaxSeq + 1;
    const to = Math.max(...incomingSeqs) - 1;
    const incoming = new Set(incomingSeqs);
    for (let n = from; n <= to; n += 1) if (!incoming.has(n)) gapSeqs.push(n);
  }
  if (gapSeqs.length > 0) {
    warnings.push({
      code: 'EVENT_GAP',
      message: `事件连续序号缺失 ${gapSeqs.slice(0, 10).join('、')}${gapSeqs.length > 10 ? ' …' : ''}，可能有丢条目`
    });
  }

  // 设备时钟回拨检测（仅告警，排序仍按序号）。
  const times = sorted.map((event) => event.clock.deviceTime);
  const knownMax = state.lastDeviceTime[deviceKey];
  let rollback = false;
  for (let i = 0; i < times.length; i += 1) {
    const ref = i === 0 ? knownMax : times[i - 1];
    if (ref !== undefined && times[i] < ref) rollback = true;
  }
  if (rollback) {
    warnings.push({
      code: 'CLOCK_ROLLBACK',
      message: '检测到设备时间回拨，已按设备连续序号而非时间戳确定顺序'
    });
  }

  // 逐条处理：单条失败不影响其他条目。
  const results: ItemResult[] = [];
  // 失败（含同包重复序号、处理异常）不固化：设备修正后重传可以重新处理；
  // 只有成功/去重/作废才沿用第一次结果。
  for (const event of sorted) {
    const base = { eventId: eventId(pkg.deviceId, pkg.patrolId, event.seq), kind: event.kind, seq: event.seq };
    try {
      if (seenSeq.has(event.seq)) {
        results.push({ ...base, ...fail('DUP_SEQ_IN_PACKAGE', `同包内连续序号 ${event.seq} 重复，本条不处理`) });
        continue;
      }
      seenSeq.add(event.seq);
      const partial = applyEvent(state, pkg, event);
      const result: ItemResult = { ...base, ...partial };
      results.push(result);
      if (result.status !== 'failed' && !state.processedEvents[base.eventId]) {
        state.processedEvents[base.eventId] = result;
      }
    } catch (error) {
      results.push({
        ...base,
        ...fail('PROCESSING_ERROR', `处理异常：${error instanceof Error ? error.message : String(error)}`)
      });
    }
  }

  // 推进水位（取最大值，旧包晚到不会让水位倒退）。
  state.lastPackageSeq[deviceKey] = Math.max(state.lastPackageSeq[deviceKey] ?? 0, pkg.packageSeq);
  if (incomingSeqs.length > 0) state.maxEventSeq[deviceKey] = Math.max(prevMaxSeq, ...incomingSeqs);
  if (times.length > 0) {
    const sortedTimes = times.slice().sort();
    const maxTime = sortedTimes[sortedTimes.length - 1];
    state.lastDeviceTime[deviceKey] =
      knownMax === undefined || maxTime > knownMax ? maxTime : knownMax;
  }

  state.reportCounter += 1;
  const report: IngestReport = {
    id: `report-${state.reportCounter}`,
    packageId: pid,
    patrolId: pkg.patrolId,
    deviceId: pkg.deviceId,
    packageSeq: pkg.packageSeq,
    ingestedAt,
    packageReplayed: false,
    packageWarnings: warnings,
    failedEvents: sorted.filter((event) =>
      results.some((result) => result.seq === event.seq && result.status === 'failed')),
    results
  };
  state.reports.unshift(report);
  return { state, report };
}
