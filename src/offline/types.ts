/**
 * 离线巡护包领域模型。
 *
 * 设计要点：
 * - 每台设备对一次巡护（patrolId 稳定巡护标识）维护一个“连续序号” seq，
 *   seq 按设备本地产生顺序单调递增，即使设备时间回拨也不回退，
 *   因此它（而非时间戳）是事件先后与去重的依据。
 * - 观察、轨迹、样本交接各自有稳定业务键（见 keys.ts），同一事件拆成多包、
 *   多设备重传都不会产生重复条目。
 * - 样本交接是只追加（append-only）的链：采集 → 交接 → 送检，
 *   任何环节都不修改历史条目，退回只追加“作废”和“补齐”记录。
 */

export type RiskLevel = 'low' | 'medium' | 'high';

/** 设备时钟信息：serverTimeAtBoot 用于量化设备时间回拨，seq 与时钟无关。 */
export interface DeviceClock {
  /** 设备当时显示的时间（ISO 字符串），可能被回拨，仅作展示与异常判定 */
  deviceTime: string;
  /** 设备最近一次联网对时得到的基准时间（ISO 字符串） */
  serverTimeAtBoot: string;
}

/* ---------------- 离线包事件 ---------------- */

export interface ObservationEvent {
  kind: 'observation';
  seq: number;
  clock: DeviceClock;
  note: string;
  risk: RiskLevel;
  /** 现场证据材料（照片编号等）；为空表示证据缺失 */
  evidenceIds: string[];
  /** 是否超出该巡护员能力范围（如需要物种专家鉴定） */
  outOfCapability: boolean;
  /** 关联样本业务键，没有则为空 */
  sampleCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface TrackEvent {
  kind: 'track';
  seq: number;
  clock: DeviceClock;
  latitude: number;
  longitude: number;
  source: 'gps' | 'manual';
  /** 与上一条同设备轨迹点之间的估算位移（米），由设备端计算 */
  deltaMeters?: number;
}

export interface CollectEvent {
  kind: 'collect';
  seq: number;
  clock: DeviceClock;
  /** 样本编号，样本的自然主键 */
  sampleCode: string;
  species: string;
  count: number;
  collectorId: string;
  collectorName: string;
  evidenceIds: string[];
}

export interface HandoverEvent {
  kind: 'handover';
  seq: number;
  clock: DeviceClock;
  sampleCode: string;
  fromPersonId: string;
  toPersonId: string;
  toPersonName: string;
  /** 交接去向：护送/转运人员，或送检机构 */
  destination: string;
  /** 封签号、双人签字照片等交接凭证；为空表示缺失证据 */
  evidenceIds: string[];
}

export type PackageEvent = ObservationEvent | TrackEvent | CollectEvent | HandoverEvent;

/**
 * 离线巡护包。同一次巡护可能被多台设备拆成多个包：
 * (deviceId, patrolId, packageSeq) 唯一标识一个包。
 */
export interface OfflinePackage {
  /** 稳定巡护标识：一次巡护全程不变 */
  patrolId: string;
  /** 设备唯一标识 */
  deviceId: string;
  deviceLabel: string;
  /** 设备内连续包序号，从 1 开始，用于发现丢包 */
  packageSeq: number;
  /** 设备内连续事件序号上界：本包事件 seq 的最大值（用于断点判断） */
  lastEventSeq: number;
  sentAt: string;
  events: PackageEvent[];
}

/* ---------------- 入库后的领域对象 ---------------- */

export interface IngestedObservation {
  key: string;
  patrolId: string;
  deviceId: string;
  seq: number;
  eventId: string;
  deviceTime: string;
  serverTimeAtBoot: string;
  /** 实际接收顺序（入库序号），时间回拨时用它稳定排序 */
  receivedOrder: number;
  note: string;
  risk: RiskLevel;
  evidenceIds: string[];
  outOfCapability: boolean;
  sampleCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface IngestedTrack {
  key: string;
  patrolId: string;
  deviceId: string;
  seq: number;
  eventId: string;
  deviceTime: string;
  receivedOrder: number;
  latitude: number;
  longitude: number;
  source: 'gps' | 'manual';
  deltaMeters?: number;
}

/** 样本交接链上的一条记录，只追加，永不修改。 */
export interface CustodyEntry {
  /** 链内序号，按 append 顺序递增（不是设备 seq） */
  chainSeq: number;
  eventId: string;
  sampleCode: string;
  patrolId: string;
  deviceId: string;
  deviceSeq: number;
  deviceTime: string;
  receivedOrder: number;
  type: 'collect' | 'handover' | 'void' | 'resume';
  fromPersonId?: string;
  toPersonId?: string;
  toPersonName?: string;
  destination?: string;
  collectorId?: string;
  collectorName?: string;
  species?: string;
  count?: number;
  evidenceIds: string[];
  /** 负责人退回/补齐审核记录 id（void/resume 时有值） */
  reviewId?: string;
  /** 作废原因（void 时有值） */
  reason?: string;
  /** 补齐说明（resume 时有值） */
  resumeNote?: string;
  /** 前一条哈希，形成不可改链 */
  prevHash: string;
  hash: string;
  /** true 表示升级前旧设备导入的记录 */
  legacy?: boolean;
}

export interface SampleRecord {
  sampleCode: string;
  species: string;
  count: number;
  /** 采集人（旧设备升级前的记录也至少保留采集人和采集时间） */
  collectorId: string;
  collectorName: string;
  collectedAt: string;
  /** true 表示来自升级前的旧格式记录 */
  legacy?: boolean;
}

/* ---------------- 负责人复核 ---------------- */

export type ReviewTarget = 'observation' | 'sample';

/** 复核三维度问题标记 */
export interface ReviewFlags {
  /** 能力范围外 */
  capability: boolean;
  /** 位置异常 */
  location: boolean;
  /** 证据缺失 */
  missingEvidence: boolean;
}

export type ReviewVerdict = 'approved' | 'returned';

export interface ReviewDecision {
  id: string;
  target: ReviewTarget;
  /** observation 业务键 或 sampleCode */
  refKey: string;
  verdict: ReviewVerdict;
  reasons: string[];
  /** 退回时要求补交的材料清单（待补材料） */
  requiredMaterials: string[];
  reviewer: string;
  decidedAt: string;
  /** 第几次复核结论，只追加，新结论永不覆盖旧结论 */
  revision: number;
}

/* ---------------- 逐条处理结果 ---------------- */

export type ItemStatus =
  | 'applied'        // 新条目，正常入库
  | 'replayed'       // 重传：沿用第一次处理结果
  | 'skipped'        // 业务键去重命中（非重传语境下的重复）
  | 'failed'         // 本条失败
  | 'auto-voided';   // 样本处于退回态，后续交接被自动作废

export interface ItemResult {
  /** 事件幂等键 */
  eventId: string;
  kind: PackageEvent['kind'];
  seq: number;
  status: ItemStatus;
  /** 失败/异常原因代码 */
  reasonCode?: string;
  /** 面向页面展示的说明 */
  message: string;
  /** 待补材料 */
  requiredMaterials?: string[];
  /** 命中的既有条目（重传/去重时） */
  existingKey?: string;
}

export interface IngestReport {
  id: string;
  packageId: string;
  patrolId: string;
  deviceId: string;
  packageSeq: number;
  ingestedAt: string;
  /** 包本身是否曾被处理过（重传沿用第一次结果） */
  packageReplayed: boolean;
  /** 包级告警，例如丢包、时钟回拨 */
  packageWarnings: { code: string; message: string }[];
  /** 本次处理失败的事件原文快照（失败不锁死，供设备/页面修正后重传） */
  failedEvents?: PackageEvent[];
  results: ItemResult[];
}
