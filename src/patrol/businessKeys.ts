import type { ObservationEntry, SampleEntry, TrackEntry } from './types';

// 稳定散列（FNV-1a 32 位）：同一内容（含设备时间）在任何设备上都得到同一业务键
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// 观察业务键：采集人 + 设备时间 + 规范化内容。设备时间回拨不影响判重（键内含真实记录时间文本）
export function observationKey(entry: Pick<ObservationEntry, 'note' | 'risk' | 'at' | 'collector'>): string {
  const normalized = entry.note.trim().replace(/\s+/g, '');
  return `obs_${fnv1a(`${entry.collector}|${entry.at}|${entry.risk}|${normalized}`)}`;
}

// 轨迹业务键：时间取整到分钟 + 坐标取 5 位小数，吸收多设备定位抖动
export function trackKey(entry: Pick<TrackEntry, 'at' | 'latitude' | 'longitude'>): string {
  const minute = entry.at.slice(0, 16);
  const lat = entry.latitude.toFixed(5);
  const lng = entry.longitude.toFixed(5);
  return `trk_${fnv1a(`${minute}|${lat}|${lng}`)}`;
}

// 样本业务键就是现场编号（全局唯一）
export function sampleKey(entry: Pick<SampleEntry, 'code'>): string {
  return `smp_${entry.code.trim()}`;
}

// 同一样本同一交接阶段只允许一段有效记录
export function segmentKey(sampleCode: string, stage: string): string {
  return `seg_${sampleCode}_${stage}`;
}

export function reviewKey(targetType: 'observation' | 'sample', targetKey: string): string {
  return `rev_${targetType}_${targetKey}`;
}
