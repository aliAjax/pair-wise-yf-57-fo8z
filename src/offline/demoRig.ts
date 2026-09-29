/**
 * 演示场景台：构造两台设备对同一次巡护的离线包队列，
 * 覆盖拆包、去重、时间回拨、单条失败、重传、旧包晚到、样本退回全流程。
 */

import { DeviceRecorder, createPatrolId } from './device';
import type { OfflinePackage } from './types';

export interface PendingPackage {
  label: string;
  pkg: OfflinePackage;
  /** 允许从该设备重传（传 packageSeq） */
  retransmitFrom?: 'A' | 'B';
  retransmitSeq?: number;
}

export class DemoRig {
  readonly patrolId = createPatrolId();
  readonly baseTime = '2026-09-29T08:00:00.000Z';
  readonly deviceA: DeviceRecorder;
  readonly deviceB: DeviceRecorder;
  readonly legacySample = {
    sampleCode: 'SMP-OLD-07',
    species: '旧设备采集的毛发样本',
    count: 1,
    collectorId: 'ranger-old',
    collectorName: '老周（升级前账号）',
    collectedAt: '2026-08-12T06:30:00.000Z'
  };

  constructor() {
    this.deviceA = new DeviceRecorder({
      deviceId: 'DEV-A11', deviceLabel: '巡护员甲的手持机',
      patrolId: this.patrolId, baseTime: this.baseTime
    });
    this.deviceB = new DeviceRecorder({
      deviceId: 'DEV-B22', deviceLabel: '巡护员乙的手持机',
      patrolId: this.patrolId, baseTime: this.baseTime
    });
  }

  /** 初始队列：拆包 + 跨设备观察/轨迹去重。 */
  buildInitial(): PendingPackage[] {
    const a = this.deviceA;
    const b = this.deviceB;

    // A 设备：连续序号 1..5，分两包
    a.recordTrack({ latitude: 30.5821, longitude: 103.2174, deltaMeters: 0 });          // seq1
    a.recordObservation({ note: '东坡溪谷发现新鲜足迹', risk: 'medium', evidenceIds: ['ph-01'], latitude: 30.5822, longitude: 103.2176 }); // seq2
    a.recordTrack({ latitude: 30.583, longitude: 103.219, deltaMeters: 180 });           // seq3
    a.recordCollect({ sampleCode: 'SMP-A', species: '疑似豹猫毛发', count: 1,            // seq4
      collectorId: 'ranger-jia', collectorName: '巡护员甲', evidenceIds: ['col-ph-1'] });
    a.recordHandover({ sampleCode: 'SMP-A', fromPersonId: 'ranger-jia',                 // seq5
      toPersonId: 'trans-li', toPersonName: '转运员李姐', destination: '样线南出口交接点', evidenceIds: ['seal-1', 'sign-1'] });
    const pkgA1 = a.seal(3);
    const pkgA2 = a.seal(2);

    // B 设备：与 A 同一分钟同一地点记录了同一条观察（业务键去重），轨迹同序号也来自不同设备
    b.recordTrack({ latitude: 30.5821, longitude: 103.2174, deltaMeters: 0 });          // seq1
    b.recordObservation({ note: '东坡溪谷发现新鲜足迹', risk: 'medium', evidenceIds: ['ph-01'], latitude: 30.5822, longitude: 103.2176 }); // seq2
    const pkgB1 = b.seal(2);

    return [
      { label: 'A 设备 · 第 1 包（轨迹+观察，3 条）', pkg: pkgA1 },
      { label: 'B 设备 · 第 1 包（与 A 同一观察/轨迹，应去重）', pkg: pkgB1 },
      { label: 'A 设备 · 第 2 包（采集+交接，2 条）', pkg: pkgA2, retransmitFrom: 'A', retransmitSeq: 2 }
    ];
  }

  /** 第二步：设备时间回拨 + 包内一条失败（空观察）+ 后续条目照常处理。 */
  buildClockRollbackPackage(): PendingPackage {
    const b = this.deviceB;
    b.rollbackClock(40); // 时钟从 08:0x 回拨到 07:2x
    b.recordObservation({ note: '高风险：发现非法套索，已定位', risk: 'high',
      evidenceIds: ['ph-trap'], latitude: 30.59, longitude: 103.23 });                  // seq3
    b.recordObservation({ note: '   ', risk: 'low' });                                   // seq4 空内容→失败
    b.recordTrack({ latitude: 30.588, longitude: 103.221, deltaMeters: 640 });           // seq5 照常处理
    b.recordCollect({ sampleCode: 'SMP-D', species: '可疑诱饵料', count: 2,
      collectorId: 'ranger-yi', collectorName: '巡护员乙', evidenceIds: ['d-ph-1'] });   // seq6 照常处理
    return { label: 'B 设备 · 第 2 包（时间回拨 40 分钟，含 1 条失败）', pkg: b.seal(4), retransmitFrom: 'B', retransmitSeq: 2 };
  }

  /**
   * 第三步：旧包晚到不顶结论（手工拼“补发包”：旧事件 + 新事件）。
   * 补发包取一个很大的包序号以通过整包幂等，携带的旧事件按事件级重传处理，
   * 并产生序号缺口与时钟回拨告警。
   */
  buildReplayAndLatePackage(): PendingPackage {
    const b = this.deviceB;
    // 取出 seq3 事件（第 2 包里已处理过的套索观察），与一个新事件 seq7 混发；
    // seq3 沿用第一次结果，seq7 正常入库。
    const original = b.retransmit(2);
    const oldEvent = structuredClone(original.events[0]);
    // 旧包即使被改成不同结论再传，也沿用第一次结果（这里故意改风险等级和内容）
    if (oldEvent.kind === 'observation') { oldEvent.risk = 'low'; oldEvent.note = '旧包里的改写内容，应被忽略'; }
    b.rollbackClock(120);
    b.recordObservation({ note: '套索已拆除，现场恢复正常', risk: 'low',
      evidenceIds: ['ph-clear'], latitude: 30.59, longitude: 103.23 });                 // seq7
    const newest = b.seal(1);
    const newEvent = newest.events[0];
    const mixed: OfflinePackage = {
      patrolId: b.patrolId, deviceId: b.deviceId, deviceLabel: b.deviceLabel,
      packageSeq: 20, // 补发包：晚到、与正常序列之间有缺口
      lastEventSeq: newEvent.seq,
      sentAt: new Date().toISOString(),
      events: [oldEvent, newEvent]
    };
    return { label: 'B 设备 · 旧事件补发包晚到（seq3 重传沿用，改写被忽略；seq7 照常入库）', pkg: mixed };
  }

  /** 样本链：正常交接（转运）。 */
  buildSampleTransfer(): PendingPackage {
    const a = this.deviceA;
    a.recordHandover({ sampleCode: 'SMP-A', fromPersonId: 'trans-li',
      toPersonId: 'store-wang', toPersonName: '站点冷库王师傅',
      destination: '站点冷库暂存', evidenceIds: ['seal-2'] });                           // seq6
    return { label: 'A 设备 · 第 3 包（SMP-A 转运至站点冷库）', pkg: a.seal(1), retransmitFrom: 'A', retransmitSeq: 3 };
  }

  /** 退回后晚到的旧交接：应自动作废（仅影响 SMP-A）。 */
  buildLateHandoverAfterReturn(): PendingPackage {
    const a = this.deviceA;
    a.recordHandover({ sampleCode: 'SMP-A', fromPersonId: 'trans-li',
      toPersonId: 'backup-zhao', toPersonName: '备用转运赵师傅',
      destination: '备用线路（旧安排）', evidenceIds: ['seal-x'] });                      // seq7
    const old = a.seal(1);
    return { label: 'A 设备 · 旧交接包晚到（SMP-A 已退回，应自动作废）', pkg: old };
  }

  /** 补齐后从退回点继续：送检交接正常入库。 */
  buildLabSend(): PendingPackage {
    const a = this.deviceA;
    a.recordHandover({ sampleCode: 'SMP-A', fromPersonId: 'store-wang',
      toPersonId: 'lab-01', toPersonName: '省林业局鉴定中心',
      destination: '省林业局鉴定中心（送检）', evidenceIds: ['seal-3', 'waybill-1'] });   // seq8
    return { label: 'A 设备 · 第 4 包（SMP-A 补齐后送检）', pkg: a.seal(1), retransmitFrom: 'A', retransmitSeq: 4 };
  }

  retransmit(device: 'A' | 'B', packageSeq: number): OfflinePackage {
    return device === 'A' ? this.deviceA.retransmit(packageSeq) : this.deviceB.retransmit(packageSeq);
  }
}
