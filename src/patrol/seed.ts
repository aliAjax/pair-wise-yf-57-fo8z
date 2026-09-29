import { produce } from 'immer';
import { deviceNow, processPacket, submitReview } from './ingest';
import type {
  HandoffEntry, ObservationEntry, OutboundPacket, PacketEntry, PatrolState, SampleEntry, TrackEntry
} from './types';

export const PATROL_ID = 'PTL-20260929-DPX';

const base: PatrolState = {
  version: 2,
  selfDeviceId: 'D-01',
  patrolId: PATROL_ID,
  clockOffsetMin: 0,
  currentUser: '李巡护',
  devices: {
    'D-01': { deviceId: 'D-01', lastSeq: 0, nextOrdinal: 11, user: '李巡护', appVersion: 2 },
    'D-02': { deviceId: 'D-02', lastSeq: 0, nextOrdinal: 11, user: '李巡护', appVersion: 2 },
    'D-03': { deviceId: 'D-03', lastSeq: 0, nextOrdinal: 11, user: '赵巡护', appVersion: 1 }
  },
  draft: [],
  outbound: [],
  receipts: [],
  observations: [],
  tracks: [],
  supplements: [],
  samples: {},
  segments: [],
  voids: [],
  reviews: {},
  reviewHistory: [],
  seqWatermark: {},
  audit: []
};

type Ctx = { state: PatrolState; ord: Record<string, number> };
const alloc = (ctx: Ctx, deviceId: string) => { const n = ctx.ord[deviceId]++; return n; };

function obs(ctx: Ctx, deviceId: string, p: Omit<ObservationEntry, 'id' | 'ordinal' | 'kind' | 'collector'> & { collector?: string }): ObservationEntry {
  const ordinal = alloc(ctx, deviceId);
  return { id: `e-${deviceId}-${ordinal}`, ordinal, kind: 'observation', collector: p.collector ?? ctx.state.devices[deviceId].user, ...p };
}
function trk(ctx: Ctx, deviceId: string, p: Omit<TrackEntry, 'id' | 'ordinal' | 'kind' | 'collector'>): TrackEntry {
  const ordinal = alloc(ctx, deviceId);
  return { id: `e-${deviceId}-${ordinal}`, ordinal, kind: 'track', collector: ctx.state.devices[deviceId].user, ...p };
}
function smp(ctx: Ctx, deviceId: string, p: Omit<SampleEntry, 'id' | 'ordinal' | 'kind' | 'collector'>): SampleEntry {
  const ordinal = alloc(ctx, deviceId);
  return { id: `e-${deviceId}-${ordinal}`, ordinal, kind: 'sample', collector: ctx.state.devices[deviceId].user, ...p };
}
function hand(ctx: Ctx, deviceId: string, p: Omit<HandoffEntry, 'id' | 'ordinal' | 'kind' | 'collector'>): HandoffEntry {
  const ordinal = alloc(ctx, deviceId);
  return { id: `e-${deviceId}-${ordinal}`, ordinal, kind: 'handoff', collector: ctx.state.devices[deviceId].user, ...p };
}

function makePacket(deviceId: string, seq: number, sealedAt: string, entries: PacketEntry[]): OutboundPacket {
  return { id: `PK-${deviceId}-${seq}`, deviceId, patrolId: PATROL_ID, seq, sealedAt, clockOffsetMin: 0, status: 'pending', sentCount: 0, entries };
}

export function createSeedState(): PatrolState {
  const ctx: Ctx = { state: base, ord: { 'D-01': 11, 'D-02': 11, 'D-03': 11 } };
  return produce(base, (draft) => {
    // —— 已同步的历史包：多设备把同一次巡护拆成多包 ——
    const p11 = makePacket('D-01', 1, '2026-09-29 07:30:00', [
      trk(ctx, 'D-01', { at: '2026-09-29 07:20:00', latitude: 30.5821, longitude: 103.2174, source: 'gps' }),
      obs(ctx, 'D-01', { at: '2026-09-29 07:25:00', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', evidencePhoto: true, withinCapability: true, latitude: 30.583, longitude: 103.218 })
    ]);
    // 备用机时间慢 15 分钟，重报同一轨迹点与同一条观察
    const p21 = makePacket('D-02', 1, '2026-09-29 07:15:00', [
      trk(ctx, 'D-02', { at: '2026-09-29 07:20:00', latitude: 30.5821, longitude: 103.2174, source: 'gps' }),
      obs(ctx, 'D-02', { at: '2026-09-29 07:25:00', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', evidencePhoto: true, withinCapability: true, latitude: 30.583, longitude: 103.218 })
    ]);
    p21.clockOffsetMin = -15;
    // 设备时间回拨：第二条轨迹的时间早于第一条
    const p22 = makePacket('D-02', 2, '2026-09-29 07:32:00', [
      trk(ctx, 'D-02', { at: '2026-09-29 07:30:00', latitude: 30.5856, longitude: 103.2211, source: 'gps' }),
      trk(ctx, 'D-02', { at: '2026-09-29 07:26:00', latitude: 30.586, longitude: 103.222, source: 'manual' })
    ]);
    p22.clockOffsetMin = -15;
    const p12 = makePacket('D-01', 2, '2026-09-29 08:20:00', [
      smp(ctx, 'D-01', { at: '2026-09-29 08:05:00', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, photo: true, labeled: true }),
      obs(ctx, 'D-01', { at: '2026-09-29 08:05:00', note: '红外相机外壳松动，已拍照待补报', risk: 'high', evidencePhoto: false, withinCapability: true, latitude: 30.586, longitude: 103.221, sampleCode: 'WD-0929-01' })
    ]);
    // 旧版 App（赵巡护）：记录只有采集人和时间可信
    const p31 = makePacket('D-03', 1, '2026-09-29 08:40:00', [
      smp(ctx, 'D-03', { at: '2026-09-29 08:10:00', code: 'WD-0929-07', species: '鸟类羽毛（旧机记录）', count: 1, photo: false, labeled: true, legacy: true }),
      obs(ctx, 'D-03', { at: '2026-09-29 08:15:00', note: '样线南段没有异常', risk: 'low', evidencePhoto: false, withinCapability: true, legacy: true })
    ]);
    // 旧机样本到站点后的第一次交接（随后被负责人退回作废）
    const p32 = makePacket('D-03', 2, '2026-09-29 09:00:00', [
      hand(ctx, 'D-03', { at: '2026-09-29 09:00:00', sampleCode: 'WD-0929-07', stage: 'handover', to: '站点冷柜', note: '旧机样本首次交接' })
    ]);

    [p11, p21, p22, p12, p31, p32].forEach((packet) => { draft.outbound.push(packet); processPacket(draft, packet); });
    draft.devices['D-01'].lastSeq = 4; // 序号 3 的包还留在山里没发出（制造缺口），4 已在待发队列
    draft.devices['D-02'].lastSeq = 2;
    draft.devices['D-03'].lastSeq = 3;
    draft.devices['D-01'].nextOrdinal = ctx.ord['D-01'];
    draft.devices['D-02'].nextOrdinal = ctx.ord['D-02'];
    draft.devices['D-03'].nextOrdinal = ctx.ord['D-03'];

    // 负责人已退回过一次 WD-0929-07：交接段作废，采集段保留
    submitReview(draft, { targetType: 'sample', targetKey: 'WD-0929-07', status: 'returned', reviewer: '周站长', note: '旧机样本缺样本照片，退回补齐，交接段作废，从交接点继续' });

    // —— 待同步队列（断网期间攒下的包）——
    const p14 = makePacket('D-01', 4, '2026-09-29 09:05:00', [
      hand(ctx, 'D-01', { at: '2026-09-29 09:05:00', sampleCode: 'WD-0929-01', stage: 'handover', to: '站点冷柜', note: '随设备下山交接' }),
      hand(ctx, 'D-01', { at: '2026-09-29 09:05:00', sampleCode: 'WD-0000-00', stage: 'handover', to: '站点冷柜' }),
      obs(ctx, 'D-01', { at: '2026-09-29 08:40:00', note: '垭口发现大型动物拖拽痕迹，疑似超出本队处置能力', risk: 'high', evidencePhoto: false, withinCapability: false, latitude: 30.9, longitude: 103.5 })
    ]);
    const p33 = makePacket('D-03', 3, '2026-09-29 09:02:00', [
      obs(ctx, 'D-03', { at: '2026-09-29 08:50:00', note: '旧机补报：发现兽夹一枚', risk: 'high', evidencePhoto: false, withinCapability: true, legacy: true })
    ]);
    p14.clockOffsetMin = 0;
    p33.clockOffsetMin = 0;
    draft.outbound.push(p14, p33);

    // 当前设备草稿箱里还没封包的一条
    draft.draft.push(obs(ctx, 'D-01', { at: deviceNow(0), note: '草稿：北坡垭口复测，待封包', risk: 'medium', evidencePhoto: true, withinCapability: true, latitude: 30.586, longitude: 103.221 }));
    draft.devices['D-01'].nextOrdinal = ctx.ord['D-01'];
    draft.devices['D-02'].nextOrdinal = ctx.ord['D-02'];
    draft.devices['D-03'].nextOrdinal = ctx.ord['D-03'];
  });
}
