import { configureStore } from '@reduxjs/toolkit';
import { patrolReducer } from './patrolSlice';

export const store = configureStore({ reducer: { patrol: patrolReducer } });

store.subscribe(() => {
  try {
    localStorage.setItem('yf57-offline-engine', JSON.stringify(store.getState().patrol.engine));
  } catch { /* 存储满等情况下忽略，内存态仍可用 */ }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export {
  ingest, review, returnSampleAction, resumeSampleAction, importLegacy, tamperHistory, resetAll
} from './patrolSlice';
