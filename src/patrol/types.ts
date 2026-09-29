// 离线巡护领域模型：设备内连续序号、稳定巡护标识、业务键去重、样本逐段交接
export type Risk = 'low' | 'medium' | 'high';
export type Stage = 'collect' | 'handover' | 'inspect';
export type EntryKind = 'observation' | 'track' | 'sample' | 'handoff' | 'supplement';
export type ReceiptStatus = 'accepted' | 'warning' | 'duplicate' | 'rejected' | 'voided';
export type PacketStatus = 'draft' | 'pending' | 'acked' | 'failed';
export type ReviewStatus = 'approved' | 'returned';
export type ReviewTarget = 'observation' | 'sample';

// 负责人可要求补的材料
export type MissingMaterial =
  | 'photo'            // 现场照片
  | 'location'         // 位置信息
  | 'sample_photo'     // 样本照片
  | 'id_note'          // 样本编号/标签
  | 'capability_report'// 能力范围说明
  | 'detail_note';     // 详细情况说明

export interface DeviceRecord {
  deviceId: string;
  // 设备内连续包序号，只增不减，设备时间回拨不影响它
  lastSeq: number;
  // 设备内条目连续序号，封包、重传、换机都不复用
  nextOrdinal: number;
  user: string;
  // 旧版 App 采集的记录只有采集人与时间；升级后仍可查看与交接
  appVersion: 1 | 2;
}

// ---- 离线包条目（判别联合）----
interface EntryBase { id: string; ordinal: number; at: string; collector: string; }
export interface ObservationEntry extends EntryBase {
  kind: 'observation';
  note: string;
  risk: Risk;
  latitude?: number;
  longitude?: number;
  evidencePhoto: boolean;
  withinCapability: boolean;
  sampleCode?: string;
  legacy?: boolean;
}
export interface TrackEntry extends EntryBase { kind: 'track'; latitude: number; longitude: number; source: 'gps' | 'manual'; }
export interface SampleEntry extends EntryBase { kind: 'sample'; code: string; species: string; count: number; photo?: boolean; labeled?: boolean; legacy?: boolean; }
export interface HandoffEntry extends EntryBase { kind: 'handoff'; sampleCode: string; stage: Exclude<Stage, 'collect'>; to: string; note?: string; }
export interface SupplementEntry extends EntryBase { kind: 'supplement'; targetType: ReviewTarget; targetKey: string; materials: MissingMaterial[]; note: string; }
export type PacketEntry = ObservationEntry | TrackEntry | SampleEntry | HandoffEntry | SupplementEntry;

export interface OutboundPacket {
  id: string;                 // 稳定包标识，重传不变
  deviceId: string;
  patrolId: string;           // 稳定巡护标识，多设备拆包共用
  seq: number;                // 设备内连续序号
  sealedAt: string;
  clockOffsetMin: number;
  status: PacketStatus;
  sentCount: number;
  lastRetransmitAt?: string;
  firstResult?: PacketReceipt;// 首次处理结果，重传一律沿用
  entries: PacketEntry[];
}

// ---- 入库后的权威数据（按业务键去重，迟到旧包不覆盖）----
export interface CanonicalObservation {
  key: string;
  entryId: string; packetId: string; deviceId: string; ordinal: number;
  collector: string; at: string;
  note: string; risk: Risk;
  latitude?: number; longitude?: number;
  evidencePhoto: boolean;
  withinCapability: boolean;
  sampleCode?: string;
  legacy?: boolean;
}
export interface CanonicalTrack {
  key: string;
  entryId: string; packetId: string; deviceId: string; ordinal: number;
  at: string; latitude: number; longitude: number; source: 'gps' | 'manual';
  flagReason?: string;
}
export interface CanonicalSample {
  code: string; species: string; count: number;
  collector: string; collectedAt: string; deviceId: string;
  state: 'active' | 'returned';
  photo?: boolean;
  labeled?: boolean;
  linkedObservationKey?: string;
  legacy?: boolean;
}
export interface CanonicalSupplement {
  id: string; targetType: ReviewTarget; targetKey: string;
  materials: MissingMaterial[]; note: string;
  collector: string; at: string; deviceId: string; ordinal: number;
}
// 样本交接逐段记录：内容一经写入不可修改，作废走独立的追加台账
export interface SampleSegment {
  id: string;
  sampleCode: string; stage: Stage;
  entryId: string; packetId: string; deviceId: string; ordinal: number;
  at: string; actor: string; to?: string; note?: string;
  legacy?: boolean;
  prevHash: string;
  hash: string;
}
export interface SegmentVoid {
  segmentId: string; sampleCode: string;
  reason: string; at: string; reviewKey: string;
}

// ---- 逐条处理结果 ----
export interface EntryReceipt {
  entryId: string;
  kind: EntryKind;
  businessKey?: string;
  status: ReceiptStatus;
  reason: string;
  missing?: MissingMaterial[];
}
export interface PacketReceipt {
  packetId: string;
  deviceId: string;
  seq: number;
  patrolId: string;
  processedAt: string;
  retransmit?: boolean;
  stale?: boolean;
  gap?: number[];
  note?: string;
  summary: { accepted: number; warning: number; duplicate: number; rejected: number; voided: number };
  entries: EntryReceipt[];
}

// ---- 复核结论（按业务键版本化，旧包顶不掉）----
export interface Review {
  key: string;
  targetType: ReviewTarget;
  targetKey: string;
  version: number;
  status: ReviewStatus;
  capability: boolean;
  location: boolean;
  evidence: boolean;
  missing: MissingMaterial[];
  note: string;
  reviewer: string;
  at: string;
}

export interface AuditEvent { id: string; at: string; actor: string; message: string; }

export interface PatrolState {
  version: 2;
  selfDeviceId: string;
  patrolId: string;
  clockOffsetMin: number;
  currentUser: string;
  devices: Record<string, DeviceRecord>;
  draft: PacketEntry[];
  outbound: OutboundPacket[];
  receipts: PacketReceipt[];
  observations: CanonicalObservation[];
  tracks: CanonicalTrack[];
  supplements: CanonicalSupplement[];
  samples: Record<string, CanonicalSample>;
  segments: SampleSegment[];
  voids: SegmentVoid[];
  reviews: Record<string, Review>;
  reviewHistory: Review[];
  // 服务器侧已收到的各设备最大连续序号，用于识别缺包与旧包
  seqWatermark: Record<string, number>;
  audit: AuditEvent[];
}
