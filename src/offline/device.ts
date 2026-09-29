/**
 * 设备端离线记录器。
 *
 * 职责：
 * - 生成并持有稳定巡护标识 patrolId（巡护开始时创建，全程不变）；
 * - 维护设备内连续事件序号 seq：只增不减，与设备时钟完全解耦，时间回拨也不回退；
 * - 事件先入本地日志，再按包序号封包；同包重传必须原样重发（幂等键不变）；
 * - 模拟设备时间回拨（demo/测试用）。
 */

import type {
  CollectEvent, DeviceClock, HandoverEvent, ObservationEvent, OfflinePackage, PackageEvent, RiskLevel, TrackEvent
} from './types';

let clockSeedCounter = 0;

export interface DeviceRecorderInit {
  deviceId: string;
  deviceLabel: string;
  patrolId: string;
  /** 伪造一个“服务器对时基准”，demo 用 */
  bootServerTime?: string;
  /** 设备当前时间偏移分钟数（负数=时钟拨慢），demo 用 */
  clockOffsetMinutes?: number;
  /** 固定基准时间（ISO），不传则取真实当前时间；demo 用于复现固定时刻 */
  baseTime?: string;
}

export class DeviceRecorder {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly patrolId: string;
  private seq = 0;
  private packageSeq = 0;
  private events: PackageEvent[] = [];
  /** 已封过包的快照，packageSeq -> 包；重传沿用原对象 */
  private sealedPackages = new Map<number, OfflinePackage>();
  private clockOffsetMinutes: number;
  private readonly bootServerTime: string;
  private readonly baseTime?: number;

  constructor(init: DeviceRecorderInit) {
    this.deviceId = init.deviceId;
    this.deviceLabel = init.deviceLabel;
    this.patrolId = init.patrolId;
    this.clockOffsetMinutes = init.clockOffsetMinutes ?? 0;
    this.bootServerTime = init.bootServerTime ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
    this.baseTime = init.baseTime ? Date.parse(init.baseTime) : undefined;
  }

  /** 设备当前显示时间；seq 与它无关，回拨只影响展示。 */
  deviceTime(): string {
    const base = this.baseTime ?? Date.now();
    return new Date(base + this.clockOffsetMinutes * 60000).toISOString();
  }

  /** demo：把设备时钟往回拨。 */
  rollbackClock(minutes: number): void {
    this.clockOffsetMinutes -= minutes;
  }

  private clock(): DeviceClock {
    return { deviceTime: this.deviceTime(), serverTimeAtBoot: this.bootServerTime };
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  recordObservation(input: {
    note: string; risk: RiskLevel; evidenceIds?: string[]; outOfCapability?: boolean;
    sampleCode?: string; latitude?: number; longitude?: number;
  }): ObservationEvent {
    const event: ObservationEvent = {
      kind: 'observation', seq: this.nextSeq(), clock: this.clock(),
      note: input.note, risk: input.risk,
      evidenceIds: input.evidenceIds ?? [],
      outOfCapability: input.outOfCapability ?? false,
      sampleCode: input.sampleCode,
      latitude: input.latitude, longitude: input.longitude
    };
    this.events.push(event);
    return event;
  }

  recordTrack(input: { latitude: number; longitude: number; source?: 'gps' | 'manual'; deltaMeters?: number }): TrackEvent {
    const event: TrackEvent = {
      kind: 'track', seq: this.nextSeq(), clock: this.clock(),
      latitude: input.latitude, longitude: input.longitude,
      source: input.source ?? 'gps', deltaMeters: input.deltaMeters
    };
    this.events.push(event);
    return event;
  }

  recordCollect(input: {
    sampleCode: string; species: string; count: number;
    collectorId: string; collectorName: string; evidenceIds?: string[];
  }): CollectEvent {
    const event: CollectEvent = {
      kind: 'collect', seq: this.nextSeq(), clock: this.clock(),
      sampleCode: input.sampleCode, species: input.species, count: input.count,
      collectorId: input.collectorId, collectorName: input.collectorName,
      evidenceIds: input.evidenceIds ?? []
    };
    this.events.push(event);
    return event;
  }

  recordHandover(input: {
    sampleCode: string; fromPersonId: string; toPersonId: string;
    toPersonName: string; destination: string; evidenceIds?: string[];
  }): HandoverEvent {
    const event: HandoverEvent = {
      kind: 'handover', seq: this.nextSeq(), clock: this.clock(),
      sampleCode: input.sampleCode, fromPersonId: input.fromPersonId,
      toPersonId: input.toPersonId, toPersonName: input.toPersonName,
      destination: input.destination, evidenceIds: input.evidenceIds ?? []
    };
    this.events.push(event);
    return event;
  }

  /** 封一个离线包；下一包从剩余事件继续。 */
  seal(size: number, sentAt?: string): OfflinePackage {
    const batch = this.events.slice(0, size);
    this.events = this.events.slice(size);
    this.packageSeq += 1;
    const pkg: OfflinePackage = {
      patrolId: this.patrolId,
      deviceId: this.deviceId,
      deviceLabel: this.deviceLabel,
      packageSeq: this.packageSeq,
      lastEventSeq: batch.length > 0 ? batch[batch.length - 1].seq : this.seq,
      sentAt: sentAt ?? this.deviceTime(),
      events: batch
    };
    this.sealedPackages.set(this.packageSeq, pkg);
    return pkg;
  }

  /** 封一个包含全部待发事件的包（现场手动上报用）。 */
  sealAll(sentAt?: string): OfflinePackage {
    return this.seal(this.events.length, sentAt);
  }

  /** 原样重传已发过的包：包序号和事件序号都不变，服务端沿用第一次结果。 */
  retransmit(packageSeq: number): OfflinePackage {
    const pkg = this.sealedPackages.get(packageSeq);
    if (!pkg) throw new Error(`设备 ${this.deviceId} 没有第 ${packageSeq} 包`);
    return structuredClone(pkg);
  }

  get pendingCount(): number { return this.events.length; }
  get currentSeq(): number { return this.seq; }
  get currentPackageSeq(): number { return this.packageSeq; }
}

/** 稳定巡护标识：一次巡护开始时生成（设备本地 UUID 风格，不依赖网络）。 */
export function createPatrolId(prefix = 'P'): string {
  clockSeedCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${day}-${rand}${clockSeedCounter}`;
}
