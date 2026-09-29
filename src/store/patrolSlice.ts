import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  createState, importLegacySample, ingestPackage, resumeSample, returnSample, reviewObservation,
  type IngestState, type SampleResumeInput, type SampleReturnInput, type ObservationReviewInput
} from '../offline/engine';
import type { OfflinePackage } from '../offline/types';
import { PATROL_ID } from '../offline/demo';

interface PatrolStoreState {
  engine: IngestState;
}

function persistedEngine(): IngestState {
  // 旧版本数据结构不兼容，读不到时重新初始化。
  try {
    const saved = localStorage.getItem('yf57-offline-engine');
    if (saved) {
      const parsed = JSON.parse(saved) as IngestState;
      if (parsed.patrolId && parsed.reports) return parsed;
    }
  } catch { /* ignore */ }
  return createState(PATROL_ID);
}

const slice = createSlice({
  name: 'offlinePatrol',
  initialState: { engine: persistedEngine() } as PatrolStoreState,
  reducers: {
    ingest: (state, action: PayloadAction<OfflinePackage>) => {
      state.engine = ingestPackage(state.engine, action.payload).state;
    },
    review: (state, action: PayloadAction<ObservationReviewInput>) => {
      reviewObservation(state.engine, action.payload);
    },
    returnSampleAction: (state, action: PayloadAction<SampleReturnInput>) => {
      returnSample(state.engine, action.payload);
    },
    resumeSampleAction: (state, action: PayloadAction<SampleResumeInput>) => {
      resumeSample(state.engine, action.payload);
    },
    importLegacy: (state, action: PayloadAction<Parameters<typeof importLegacySample>[1]>) => {
      importLegacySample(state.engine, action.payload);
    },
    /** 演示用：模拟有人直接改库，验证哈希链会发现历史被篡改。 */
    tamperHistory: (state, action: PayloadAction<{ sampleCode: string; chainSeq: number }>) => {
      const entry = state.engine.custody.find(
        (item) => item.sampleCode === action.payload.sampleCode && item.chainSeq === action.payload.chainSeq
      );
      if (entry) entry.evidenceIds = ['tampered-evidence'];
    },
    resetAll: () => ({ engine: createState(PATROL_ID) })
  }
});

export const {
  ingest, review, returnSampleAction, resumeSampleAction, importLegacy, tamperHistory, resetAll
} = slice.actions;
export const patrolReducer = slice.reducer;
