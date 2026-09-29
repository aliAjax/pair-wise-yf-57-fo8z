import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import Taro from '@tarojs/taro';
import { audit, deviceNow, makeHandoff, processPacket, submitReview } from '../patrol/ingest';
import { createSeedState } from '../patrol/seed';
import type {
  HandoffEntry, MissingMaterial, OutboundPacket, PacketEntry, PatrolState, ReviewTarget, Risk
} from '../patrol/types';

const STORAGE_KEY = 'yf57-patrol-state-v2';

function readState(): PatrolState {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as PatrolState;
      if (parsed.version === 2) return parsed;
    }
  } catch { /* 落库损坏时回退种子 */ }
  return createSeedState();
}

function nextEntryId(state: PatrolState): { id: string; ordinal: number } {
  const device = state.devices[state.selfDeviceId];
  const ordinal = device.nextOrdinal;
  device.nextOrdinal += 1;
  return { id: `e-${state.selfDeviceId}-${ordinal}`, ordinal };
}

type NewObservation = { note: string; risk: Risk; evidencePhoto: boolean; withinCapability: boolean; latitude?: number; longitude?: number; sampleCode?: string };
type NewSample = { code: string; species: string; count: number; photo: boolean; labeled: boolean };

const slice = createSlice({
  name: 'patrol',
  initialState: readState,
  reducers: {
    addDraftObservation: (state, action: PayloadAction<NewObservation>) => {
      const { id, ordinal } = nextEntryId(state);
      const entry: PacketEntry = {
        id, ordinal, kind: 'observation', at: deviceNow(state.clockOffsetMin),
        collector: state.currentUser, ...action.payload
      };
      state.draft.push(entry);
      audit(state, state.currentUser, `草稿新增观察 #${ordinal}`);
    },
    addDraftTrack: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      const { id, ordinal } = nextEntryId(state);
      state.draft.push({
        id, ordinal, kind: 'track', at: deviceNow(state.clockOffsetMin), collector: state.currentUser,
        latitude: action.payload.latitude, longitude: action.payload.longitude, source: 'gps'
      });
    },
    addDraftSample: (state, action: PayloadAction<NewSample>) => {
      const { id, ordinal } = nextEntryId(state);
      state.draft.push({
        id, ordinal, kind: 'sample', at: deviceNow(state.clockOffsetMin), collector: state.currentUser, ...action.payload
      });
    },
    // 草稿封包：设备内连续序号 + 稳定巡护标识
    sealPacket: (state) => {
      if (state.draft.length === 0) return;
      const device = state.devices[state.selfDeviceId];
      device.lastSeq += 1;
      const seq = device.lastSeq;
      const packet: OutboundPacket = {
        id: `PK-${state.selfDeviceId}-${seq}`,
        deviceId: state.selfDeviceId,
        patrolId: state.patrolId,
        seq,
        sealedAt: deviceNow(0),
        clockOffsetMin: state.clockOffsetMin,
        status: 'pending',
        sentCount: 0,
        entries: state.draft
      };
      state.outbound.push(packet);
      state.draft = [];
      audit(state, state.currentUser, `封包 ${state.selfDeviceId}#${seq}（${packet.entries.length} 条，巡护 ${state.patrolId}）`);
    },
    // 断网恢复：所有待同步包按设备序号依次入库；包内某条失败不影响其他条目
    syncAll: (state) => {
      const pending = state.outbound
        .filter((p) => p.status === 'pending' && !p.firstResult)
        .sort((a, b) => (a.deviceId === b.deviceId ? a.seq - b.seq : a.deviceId.localeCompare(b.deviceId)));
      pending.forEach((packet) => {
        packet.sentCount += 1;
        processPacket(state, packet);
      });
    },
    // 重传：沿用第一次处理结果，不重新判重、不覆盖结论
    retransmit: (state, action: PayloadAction<string>) => {
      const packet = state.outbound.find((p) => p.id === action.payload);
      if (packet) {
        packet.sentCount += 1;
        packet.lastRetransmitAt = deviceNow(0);
        audit(state, state.currentUser, `重传 ${packet.deviceId}#${packet.seq}：沿用首次结果，未重新处理`);
      }
    },
    // 站点侧：样本交接 / 送检，封成即发，走同一条入库链路
    sendHandoff: (state, action: PayloadAction<Omit<HandoffEntry, 'id' | 'ordinal' | 'at' | 'collector' | 'kind'>>) => {
      const entry = makeHandoff(state, action.payload);
      const device = state.devices[state.selfDeviceId];
      device.nextOrdinal += 1;
      device.lastSeq += 1;
      const packet: OutboundPacket = {
        id: `PK-${state.selfDeviceId}-${device.lastSeq}`,
        deviceId: state.selfDeviceId, patrolId: state.patrolId, seq: device.lastSeq,
        sealedAt: deviceNow(0), clockOffsetMin: 0, status: 'pending', sentCount: 1, entries: [entry]
      };
      state.outbound.push(packet);
      processPacket(state, packet);
    },
    // 退回后补齐材料：进入当前设备草稿，封包后从退回点继续
    addDraftSupplement: (state, action: PayloadAction<{ targetType: ReviewTarget; targetKey: string; materials: MissingMaterial[]; note: string }>) => {
      const { id, ordinal } = nextEntryId(state);
      state.draft.push({ id, ordinal, kind: 'supplement', at: deviceNow(0), collector: state.currentUser, ...action.payload });
    },
    review: (state, action: PayloadAction<{ targetType: ReviewTarget; targetKey: string; status: 'approved' | 'returned'; reviewer: string; note: string }>) => {
      submitReview(state, action.payload);
    },
    setClockOffset: (state, action: PayloadAction<number>) => { state.clockOffsetMin = action.payload; },
    switchDevice: (state, action: PayloadAction<string>) => {
      state.selfDeviceId = action.payload;
      state.currentUser = state.devices[action.payload].user;
      state.clockOffsetMin = 0;
    },
    // 旧机升级：旧记录仍在（只有采集人与时间），之后可正常查看与交接
    upgradeDevice: (state, action: PayloadAction<string>) => {
      const device = state.devices[action.payload];
      if (device) device.appVersion = 2;
      audit(state, device?.user ?? 'system', `${action.payload} 已升级到新版 App，历史记录全部保留`);
    },
    resetDemo: (state) => {
      const fresh = createSeedState();
      Object.assign(state, fresh);
      Taro.setStorageSync(STORAGE_KEY, JSON.stringify(fresh));
    }
  }
});

export const {
  addDraftObservation, addDraftTrack, addDraftSample, sealPacket, syncAll, retransmit,
  sendHandoff, addDraftSupplement, review, setClockOffset, switchDevice, upgradeDevice, resetDemo
} = slice.actions;

export const store = configureStore({ reducer: { patrol: slice.reducer } });

let writeTimer: ReturnType<typeof setTimeout> | undefined;
store.subscribe(() => {
  if (typeof setTimeout === 'undefined') {
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol));
    return;
  }
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol)), 120);
});

export type RootState = ReturnType<typeof store.getState>;
