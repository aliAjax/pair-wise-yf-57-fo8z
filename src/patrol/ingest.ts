import type { WritableDraft } from 'immer';
import { fnv1a, observationKey, reviewKey, segmentKey, trackKey } from './businessKeys';
import type {
  AuditEvent, CanonicalObservation, EntryReceipt, HandoffEntry, MissingMaterial,
  OutboundPacket, PacketEntry, PacketReceipt, PatrolState, Review, ReviewTarget, SampleSegment
} from './types';

let auditSeq = 0;
export function audit(state: WritableDraft<PatrolState>, actor: string, message: string): void {
  auditSeq += 1;
  const event: AuditEvent = { id: `a-${Date.now()}-${auditSeq}`, at: deviceNow(0), actor, message };
  state.audit.unshift(event);
}

// 设备时间：允许回拨；序号（ordinal/seq）单调，不依赖时钟
export function deviceNow(offsetMin: number): string {
  const d = new Date(Date.now() + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 观察位置异常：与最近一条轨迹（按序号，而非时间——时间可能回拨）距离超过 3 公里
export function observationLocationAnomaly(state: WritableDraft<PatrolState>, latitude?: number, longitude?: number): boolean {
  if (latitude === undefined || longitude === undefined) return true;
  const lastTrack = [...state.tracks].sort((x, y) => y.ordinal - x.ordinal)[0];
  if (!lastTrack) return false;
  return haversineKm({ latitude, longitude }, lastTrack) > 3;
}

// 轨迹异常：设备时间回拨（dt<=0）按序号排序并标记；位移速度超过 120km/h 标记
export function trackFlag(state: WritableDraft<PatrolState>, at: string, latitude: number, longitude: number): string | undefined {
  const prev = [...state.tracks].sort((x, y) => y.ordinal - x.ordinal)[0];
  if (!prev) return undefined;
  const dt = (new Date(at.replace(' ', 'T')).getTime() - new Date(prev.at.replace(' ', 'T')).getTime()) / 1000;
  if (dt <= 0) return '设备时间回拨，已按设备内序号排序，时间顺序异常待负责人确认';
  const speed = haversineKm(prev, { latitude, longitude }) / (dt / 3600);
  if (speed > 120) return `位移速度 ${speed.toFixed(0)} km/h 超出步行巡护合理范围`;
  return undefined;
}

function missingForObservation(
  state: WritableDraft<PatrolState>, obs: { withinCapability: boolean; evidencePhoto: boolean; latitude?: number; longitude?: number; key: string }
): MissingMaterial[] {
  const missing: MissingMaterial[] = [];
  if (!obs.evidencePhoto) missing.push('photo');
  if (!obs.withinCapability) missing.push('capability_report');
  if (observationLocationAnomaly(state, obs.latitude, obs.longitude)) missing.push('location');
  // 已补材料从缺失清单中剔除（补充包只追加，不改原始记录）
  const covered = new Set(state.supplements.filter((s) => s.targetType === 'observation' && s.targetKey === obs.key).flatMap((s) => s.materials));
  return missing.filter((m) => !covered.has(m));
}

function missingForSample(state: WritableDraft<PatrolState>, code: string): MissingMaterial[] {
  const sample = state.samples[code];
  const missing: MissingMaterial[] = [];
  if (!sample) return ['sample_photo', 'id_note'];
  if (sample.legacy || sample.photo === false) missing.push('sample_photo');
  if (!sample.species.trim() || sample.labeled === false) missing.push('id_note');
  const covered = new Set(state.supplements.filter((s) => s.targetType === 'sample' && s.targetKey === code).flatMap((s) => s.materials));
  return missing.filter((m) => !covered.has(m));
}

function chainHash(prevHash: string, payload: string): string {
  return fnv1a(`${prevHash}|${payload}`);
}

function latestSegment(state: WritableDraft<PatrolState>, sampleCode: string): WritableDraft<SampleSegment> | undefined {
  return state.segments.filter((s) => s.sampleCode === sampleCode).slice(-1)[0];
}
function activeSegments(state: WritableDraft<PatrolState>, sampleCode: string) {
  const voidIds = new Set(state.voids.map((v) => v.segmentId));
  return state.segments.filter((s) => s.sampleCode === sampleCode && !voidIds.has(s.id));
}

function processEntry(state: WritableDraft<PatrolState>, packet: WritableDraft<OutboundPacket>, entry: PacketEntry): EntryReceipt {
  // 任何一条抛错都不影响同包其他条目
  try {
    switch (entry.kind) {
      case 'observation': {
        const key = observationKey(entry);
        const existed = state.observations.find((o) => o.key === key);
        if (existed) {
          return { entryId: entry.id, kind: 'observation', businessKey: key, status: 'duplicate', reason: '同一观察已由首次到包入库（业务键去重），旧包不覆盖已有记录与复核结论' };
        }
        const canonical: CanonicalObservation = {
          key, entryId: entry.id, packetId: packet.id, deviceId: packet.deviceId, ordinal: entry.ordinal,
          collector: entry.collector, at: entry.at, note: entry.note, risk: entry.risk,
          latitude: entry.latitude, longitude: entry.longitude,
          evidencePhoto: entry.evidencePhoto, withinCapability: entry.withinCapability,
          sampleCode: entry.sampleCode, legacy: entry.legacy
        };
        state.observations.push(canonical);
        if (entry.sampleCode && state.samples[entry.sampleCode]) state.samples[entry.sampleCode].linkedObservationKey = key;
        const missing = missingForObservation(state, canonical);
        if (entry.legacy) {
          return { entryId: entry.id, kind: 'observation', businessKey: key, status: 'warning', reason: '旧版 App 记录：仅保留采集人与时间，升级后仍可查看，请补现场证据', missing };
        }
        if (missing.length) {
          return { entryId: entry.id, kind: 'observation', businessKey: key, status: 'warning', reason: '已入库，但命中负责人复核规则：能力范围/位置异常/证据缺失', missing };
        }
        return { entryId: entry.id, kind: 'observation', businessKey: key, status: 'accepted', reason: '入库成功' };
      }
      case 'track': {
        const key = trackKey(entry);
        if (state.tracks.some((t) => t.key === key)) {
          return { entryId: entry.id, kind: 'track', businessKey: key, status: 'duplicate', reason: '同一轨迹点已入库（时间+坐标业务键），多设备拆包不重复计点' };
        }
        const flag = trackFlag(state, entry.at, entry.latitude, entry.longitude);
        state.tracks.push({
          key, entryId: entry.id, packetId: packet.id, deviceId: packet.deviceId, ordinal: entry.ordinal,
          at: entry.at, latitude: entry.latitude, longitude: entry.longitude, source: entry.source, flagReason: flag
        });
        return flag
          ? { entryId: entry.id, kind: 'track', businessKey: key, status: 'warning', reason: flag }
          : { entryId: entry.id, kind: 'track', businessKey: key, status: 'accepted', reason: '入库成功' };
      }
      case 'sample': {
        if (state.samples[entry.code]) {
          return { entryId: entry.id, kind: 'sample', businessKey: entry.code, status: 'duplicate', reason: '样本编号已存在，迟到旧包不覆盖首次登记' };
        }
        state.samples[entry.code] = {
          code: entry.code, species: entry.species, count: entry.count,
          collector: entry.collector, collectedAt: entry.at, deviceId: packet.deviceId,
          state: 'active', photo: entry.photo, labeled: entry.labeled, legacy: entry.legacy
        };
        const payload = `${entry.code}|collect|${entry.at}|${entry.collector}|${entry.species}|${entry.count}`;
        state.segments.push({
          id: segmentKey(entry.code, 'collect'), sampleCode: entry.code, stage: 'collect',
          entryId: entry.id, packetId: packet.id, deviceId: packet.deviceId, ordinal: entry.ordinal,
          at: entry.at, actor: entry.collector, note: entry.legacy ? '旧版 App 迁移：仅采集人与时间' : '现场采集登记',
          legacy: entry.legacy, prevHash: 'GENESIS', hash: chainHash('GENESIS', payload)
        });
        return entry.legacy
          ? { entryId: entry.id, kind: 'sample', businessKey: entry.code, status: 'warning', reason: '旧版样本迁移成功，采集段保留，待补样本照片', missing: missingForSample(state, entry.code) }
          : { entryId: entry.id, kind: 'sample', businessKey: entry.code, status: 'accepted', reason: '样本登记成功，采集段已上链' };
      }
      case 'handoff': {
        const sample = state.samples[entry.sampleCode];
        if (!sample) {
          return { entryId: entry.id, kind: 'handoff', businessKey: entry.sampleCode, status: 'rejected', reason: `样本 ${entry.sampleCode} 尚未入库（包可能乱序），该交接暂不受理，采集包到达后可重传` };
        }
        const active = activeSegments(state, entry.sampleCode);
        if (sample.state === 'returned') {
          return { entryId: entry.id, kind: 'handoff', businessKey: entry.sampleCode, status: 'rejected', reason: '样本处于退回状态：原交接已作废，请等负责人确认补齐材料后从退回点重新交接' };
        }
        const sameStage = active.find((s) => s.stage === entry.stage);
        if (sameStage) {
          return { entryId: entry.id, kind: 'handoff', businessKey: entry.sampleCode, status: 'rejected', reason: `${stageLabel(entry.stage)}段交接已存在，逐段交接不可重复或修改` };
        }
        const prevStage = entry.stage === 'inspect' ? 'handover' : 'collect';
        const predecessor = active.find((s) => s.stage === prevStage);
        if (!predecessor) {
          return { entryId: entry.id, kind: 'handoff', businessKey: entry.sampleCode, status: 'rejected', reason: `缺少${stageLabel(prevStage)}有效记录，不能跳到${stageLabel(entry.stage)}` };
        }
        const last = latestSegment(state, entry.sampleCode);
        const prevHash = last ? last.hash : 'GENESIS';
        const payload = `${entry.sampleCode}|${entry.stage}|${entry.at}|${entry.collector}|${entry.to}|${entry.note ?? ''}`;
        state.segments.push({
          id: `seg_${entry.sampleCode}_${entry.stage}_${entry.ordinal}`, sampleCode: entry.sampleCode, stage: entry.stage,
          entryId: entry.id, packetId: packet.id, deviceId: packet.deviceId, ordinal: entry.ordinal,
          at: entry.at, actor: entry.collector, to: entry.to, note: entry.note,
          prevHash, hash: chainHash(prevHash, payload)
        });
        return { entryId: entry.id, kind: 'handoff', businessKey: entry.sampleCode, status: 'accepted', reason: `${stageLabel(entry.stage)}段交接成功，已接哈希链，记录不可修改` };
      }
      case 'supplement': {
        const exists = entry.targetType === 'observation'
          ? state.observations.some((o) => o.key === entry.targetKey)
          : Boolean(state.samples[entry.targetKey]);
        if (!exists) {
          return { entryId: entry.id, kind: 'supplement', businessKey: entry.targetKey, status: 'rejected', reason: '补充材料找不到对应退回对象，未关联入库' };
        }
        state.supplements.push({
          id: `sup_${entry.ordinal}`, targetType: entry.targetType, targetKey: entry.targetKey,
          materials: entry.materials, note: entry.note,
          collector: entry.collector, at: entry.at, deviceId: packet.deviceId, ordinal: entry.ordinal
        });
        const stillMissing = entry.targetType === 'observation'
          ? state.observations.find((o) => o.key === entry.targetKey)
            ? missingForObservation(state, state.observations.find((o) => o.key === entry.targetKey)!)
            : []
          : missingForSample(state, entry.targetKey);
        return {
          entryId: entry.id, kind: 'supplement', businessKey: entry.targetKey, status: 'accepted',
          reason: stillMissing.length ? `材料已登记，仍缺：${stillMissing.map(materialLabel).join('、')}` : '材料已补齐，可从退回点继续交接/复核'
        };
      }
    }
  } catch (err) {
    return { entryId: entry.id, kind: entry.kind, status: 'rejected', reason: `本条处理失败已跳过：${(err as Error).message}；同包其他条目不受影响` };
  }
}

// 服务端入库：幂等。同一包重传直接沿用第一次处理结果
export function processPacket(state: WritableDraft<PatrolState>, packet: WritableDraft<OutboundPacket>): PacketReceipt {
  if (packet.firstResult) return packet.firstResult;

  const watermark = state.seqWatermark[packet.deviceId] ?? 0;
  const already = state.receipts.find((r) => r.packetId === packet.id);
  if (already) return already;

  const gap: number[] = [];
  let stale = false;
  if (packet.seq <= watermark) {
    stale = true;
  } else if (packet.seq > watermark + 1) {
    for (let s = watermark + 1; s < packet.seq; s += 1) gap.push(s);
  }

  const entries = packet.entries.map((entry) => processEntry(state, packet, entry));
  const summary = {
    accepted: entries.filter((e) => e.status === 'accepted').length,
    warning: entries.filter((e) => e.status === 'warning').length,
    duplicate: entries.filter((e) => e.status === 'duplicate').length,
    rejected: entries.filter((e) => e.status === 'rejected').length,
    voided: entries.filter((e) => e.status === 'voided').length
  };
  const note = stale
    ? '旧序号包：服务端已有更新水位，仅按业务键判重，未覆盖任何已有结论'
    : gap.length
      ? `检测到设备内缺包：序号 ${gap.join('、')} 未到，已登记缺口`
      : undefined;

  const receipt: PacketReceipt = {
    packetId: packet.id, deviceId: packet.deviceId, seq: packet.seq, patrolId: packet.patrolId,
    processedAt: deviceNow(0), stale, gap: gap.length ? gap : undefined, note, summary, entries
  };
  state.receipts.unshift(receipt);
  packet.firstResult = receipt;
  packet.status = entries.some((e) => e.status === 'rejected') ? 'failed' : 'acked';
  if (!stale && packet.seq === watermark + 1) state.seqWatermark[packet.deviceId] = packet.seq;
  audit(state, 'server', `处理 ${packet.deviceId} 第 ${packet.seq} 包：收 ${summary.accepted} 警 ${summary.warning} 重 ${summary.duplicate} 拒 ${summary.rejected}`);
  return receipt;
}

// 负责人复核：能力范围 / 位置异常 / 缺失证据；版本化，任何同步包都改不了结论
export function submitReview(
  state: WritableDraft<PatrolState>,
  params: { targetType: ReviewTarget; targetKey: string; status: 'approved' | 'returned'; reviewer: string; note: string }
): Review {
  const prev = Object.values(state.reviews).filter((r) => r.targetType === params.targetType && r.targetKey === params.targetKey)
    .sort((a, b) => b.version - a.version)[0];

  let capability = true;
  let location = true;
  let evidence = true;
  let missing: MissingMaterial[] = [];
  if (params.targetType === 'observation') {
    const obs = state.observations.find((o) => o.key === params.targetKey);
    if (!obs) throw new Error('观察不存在');
    capability = obs.withinCapability;
    location = !observationLocationAnomaly(state, obs.latitude, obs.longitude);
    evidence = obs.evidencePhoto;
    missing = missingForObservation(state, obs);
  } else {
    const sample = state.samples[params.targetKey];
    if (!sample) throw new Error('样本不存在');
    missing = missingForSample(state, sample.code);
    evidence = missing.length === 0;
  }

  const review: Review = {
    key: reviewKey(params.targetType, params.targetKey),
    targetType: params.targetType, targetKey: params.targetKey,
    version: prev ? prev.version + 1 : 1,
    status: params.status,
    capability, location, evidence,
    missing: params.status === 'returned' ? missing : [],
    note: params.note, reviewer: params.reviewer, at: deviceNow(0)
  };
  state.reviews[review.key] = review;
  state.reviewHistory.push(review);

  if (params.targetType === 'sample') {
    const sample = state.samples[params.targetKey];
    if (params.status === 'returned') {
      // 只作废受影响样本的后续交接（采集段保留）
      sample.state = 'returned';
      const voidIds = new Set(state.voids.map((v) => v.segmentId));
      activeSegments(state, sample.code).filter((s) => s.stage !== 'collect').forEach((seg) => {
        if (!voidIds.has(seg.id)) {
          state.voids.push({ segmentId: seg.id, sampleCode: sample.code, reason: params.note || '负责人退回，后续交接作废', at: review.at, reviewKey: review.key });
        }
      });
      audit(state, params.reviewer, `退回样本 ${sample.code}：交接/送检段作废，采集段保留，待补齐后从退回点继续`);
    } else {
      sample.state = 'active';
      audit(state, params.reviewer, `核准样本 ${sample.code}（复核 v${review.version}）`);
    }
  } else {
    audit(state, params.reviewer, `${params.status === 'returned' ? '退回' : '核准'}观察 ${params.targetKey}（复核 v${review.version}）`);
  }
  return review;
}

export function stageLabel(stage: string): string {
  return stage === 'collect' ? '采集' : stage === 'handover' ? '交接' : '送检';
}
export function materialLabel(m: MissingMaterial): string {
  return ({ photo: '现场照片', location: '位置说明', sample_photo: '样本照片', id_note: '样本编号标签', capability_report: '能力范围说明', detail_note: '详细情况说明' })[m];
}
export function statusLabel(s: string): string {
  return ({ accepted: '接收', warning: '接收待复核', duplicate: '重复跳过', rejected: '失败', voided: '已作废', draft: '草稿', pending: '待同步', acked: '已受理', failed: '部分失败' } as Record<string, string>)[s] ?? s;
}

// 供 UI/测试构造交接、送检条目（站点侧操作，封成即发的包走同一条入库链路）
export function makeHandoff(state: WritableDraft<PatrolState>, input: Omit<HandoffEntry, 'id' | 'ordinal' | 'at' | 'collector' | 'kind'>): HandoffEntry {
  const device = state.devices[state.selfDeviceId];
  return { kind: 'handoff', ...input, id: `e-${state.selfDeviceId}-${device.nextOrdinal}`, ordinal: device.nextOrdinal, at: deviceNow(state.clockOffsetMin), collector: state.currentUser };
}
