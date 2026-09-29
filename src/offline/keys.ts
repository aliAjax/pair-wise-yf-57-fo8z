/**
 * 业务键与幂等键定义。
 *
 * - eventId：同一事件的全局唯一身份。设备对同一事件重传/拆包必须携带相同 eventId；
 *   事件一旦产生，eventId 永不改变（即使设备时间回拨）。
 * - observationKey：业务去重键，两台设备记录了同一观察时可以判重；
 * - trackKeyOf：轨迹按“设备 + 连续序号”判同，时间回拨也不会错序或重复；
 * - collectKey/handoverKey：样本交接环节业务键，重传不产生重复交接。
 */

import type { CollectEvent, HandoverEvent, ObservationEvent, PackageEvent, TrackEvent } from './types';
import { fnv1a64 } from './crypto';

/** 事件幂等键：设备第一次产生事件时确定，重传沿用。 */
export function eventId(deviceId: string, patrolId: string, seq: number): string {
  return `ev:${deviceId}:${patrolId}:${seq}`;
}

/** 包幂等键：同包重传沿用第一次处理结果。 */
export function packageId(p: { deviceId: string; patrolId: string; packageSeq: number }): string {
  return `pkg:${p.deviceId}:${p.patrolId}:${p.packageSeq}`;
}

/**
 * 观察业务键：同一分钟、同一地点的观察视为同一条（不依赖文字内容，
 * 这样旧包把备注改写后重传也仍然命中同一条，沿用第一次结果）。
 */
export function observationKey(e: ObservationEvent): string {
  const minute = e.clock.deviceTime.slice(0, 16); // YYYY-MM-DDTHH:MM
  const lat = e.latitude === undefined ? 'na' : Math.round(e.latitude * 1e4);
  const lng = e.longitude === undefined ? 'na' : Math.round(e.longitude * 1e4);
  return `obs:${fnv1a64(`${minute}|${lat}|${lng}`)}`;
}

/** 轨迹业务键：同设备同连续序号即同一个轨迹点。 */
export function trackKeyOf(deviceId: string, e: TrackEvent): string {
  return `trk:${deviceId}:${e.seq}`;
}

/** 样本以样本编号为自然主键。 */
export function sampleKey(code: string): string {
  return `smp:${code}`;
}

/** 采集环节业务键：一样本只有一条采集记录。 */
export function collectKey(e: CollectEvent): string {
  return `col:${e.sampleCode}`;
}

/** 交接环节业务键：同一次“从某人到某人”的交接重传只算一次。 */
export function handoverKey(e: HandoverEvent): string {
  return `hov:${e.sampleCode}:${e.fromPersonId}:${e.toPersonId}:${e.destination}`;
}

export function keyOfEvent(deviceId: string, e: PackageEvent): string {
  switch (e.kind) {
    case 'observation': return observationKey(e);
    case 'track': return trackKeyOf(deviceId, e);
    case 'collect': return collectKey(e);
    case 'handover': return handoverKey(e);
  }
}
