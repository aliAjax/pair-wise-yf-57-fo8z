import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { importLegacy, ingest, resetAll, resumeSampleAction, returnSampleAction, review, tamperHistory } from '../../store';
import type { RootState } from '../../store';
import { detectFlags, flagReasons, statusLabel, verifyChain } from '../../offline/engine';
import type { CustodyEntry, IngestReport, ItemResult, OfflinePackage, PackageEvent, RiskLevel } from '../../offline/types';
import { getRig, resetRig, PATROL_ID } from '../../offline/demo';
import type { PendingPackage } from '../../offline/demoRig';
import { DeviceRecorder } from '../../offline/device';
import './index.scss';

interface QueueItem extends PendingPackage { uid: string }
let uidCounter = 0;

const STATUS_CLASS: Record<ItemResult['status'], string> = {
  applied: 'ok', replayed: 'replay', skipped: 'skip', failed: 'bad', 'auto-voided': 'void'
};

function shortTime(iso: string): string {
  return iso.replace('T', ' ').slice(5, 19);
}

/* ---------------- 头部 ---------------- */

function Header({ onReset }: { onReset: () => void }) {
  return <View className="hero">
    <Text className="eyebrow">OFFLINE PATROL PACKAGES · PORT 62022</Text>
    <Text className="title">离线巡护包 · 接收与复核台</Text>
    <Text className="sub">稳定巡护标识：<Text className="mono">{PATROL_ID}</Text> · 多设备拆包合并、按连续序号排序、重传沿用第一次结果。</Text>
    <Button className="hero-btn" size="mini" onClick={onReset}>清空并重置演示</Button>
  </View>;
}

/* ---------------- 现场设备（录入 + 打包上报） ---------------- */

function FieldPanel({ onEnqueue }: { onEnqueue: (items: QueueItem[]) => void }) {
  const rig = getRig();
  const [device, setDevice] = useState<'A' | 'B'>('A');
  const [note, setNote] = useState('');
  const [risk, setRisk] = useState<RiskLevel>('low');
  const [sampleCode, setSampleCode] = useState('');
  const [species, setSpecies] = useState('');
  const [count, setCount] = useState('1');
  const [coords, setCoords] = useState('30.583, 103.219');
  const [message, setMessage] = useState('');

  const recorder = (): DeviceRecorder => (device === 'A' ? rig.deviceA : rig.deviceB);
  const collector = device === 'A'
    ? { collectorId: 'ranger-jia', collectorName: '巡护员甲' }
    : { collectorId: 'ranger-yi', collectorName: '巡护员乙' };

  const addTrack = () => {
    const [lat, lng] = coords.split(',').map((part) => Number(part.trim()));
    recorder().recordTrack({ latitude: lat || 0, longitude: lng || 0 });
    setMessage(`已写入 ${device} 设备本地日志（待发包）`);
  };
  const addObservation = () => {
    if (!note.trim()) { setMessage('观察内容为空，先写内容'); return; }
    const [lat, lng] = coords.split(',').map((part) => Number(part.trim()));
    recorder().recordObservation({
      note, risk,
      evidenceIds: risk === 'high' ? [`ph-${Date.now() % 100000}`] : [],
      latitude: lat, longitude: lng
    });
    setNote('');
    setMessage('观察已记录');
  };
  const addCollect = () => {
    if (!sampleCode.trim()) { setMessage('先填样本编号'); return; }
    recorder().recordCollect({
      sampleCode: sampleCode.trim(), species: species || '未命名样本',
      count: Number(count) || 1, ...collector, evidenceIds: [`col-${Date.now() % 100000}`]
    });
    setSampleCode(''); setSpecies('');
    setMessage(`样本 ${sampleCode} 采集已记录`);
  };
  const addHandover = () => {
    if (!sampleCode.trim()) { setMessage('先填要交接的样本编号'); return; }
    recorder().recordHandover({
      sampleCode: sampleCode.trim(),
      fromPersonId: collector.collectorId,
      toPersonId: 'store-wang', toPersonName: '站点冷库王师傅',
      destination: '站点冷库暂存', evidenceIds: [`seal-${Date.now() % 100000}`]
    });
    setSampleCode('');
    setMessage('交接已记录');
  };
  const sealAndEnqueue = () => {
    const r = recorder();
    if (r.pendingCount === 0) { setMessage('该设备本地日志没有待发事件'); return; }
    const pkg = r.sealAll();
    onEnqueue([{ uid: `q-${++uidCounter}`, label: `${device} 设备 · 现场手动封包 #${pkg.packageSeq}（${pkg.events.length} 条）`, pkg, retransmitFrom: device, retransmitSeq: pkg.packageSeq }]);
    setMessage(`已封第 ${pkg.packageSeq} 包，等待“联网接收”`);
  };

  return <View className="card">
    <View className="card-title">巡护设备端 · 离线录入与封包
      <Text className="count">A 待发 {rig.deviceA.pendingCount} · B 待发 {rig.deviceB.pendingCount}</Text>
    </View>
    <View className="device-switch">
      <button className={device === 'A' ? 'chip on' : 'chip'} onClick={() => setDevice('A')}>A · 巡护员甲手持机</button>
      <button className={device === 'B' ? 'chip on' : 'chip'} onClick={() => setDevice('B')}>B · 巡护员乙手持机</button>
    </View>
    <Textarea className="textarea" placeholder="观察内容（痕迹、风险、现场情况）" value={note} onInput={(e) => setNote(e.detail.value)} />
    <View className="row">
      <Input className="input grow" placeholder="坐标 lat, lng" value={coords} onInput={(e) => setCoords(e.detail.value)} />
      <select className="select" value={risk} onChange={(e) => setRisk(e.target.value as RiskLevel)}>
        <option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option>
      </select>
    </View>
    <View className="row">
      <Button size="mini" className="mini" onClick={addObservation}>写观察</Button>
      <Button size="mini" className="mini" onClick={addTrack}>写轨迹点</Button>
    </View>
    <View className="row">
      <Input className="input grow" placeholder="样本编号" value={sampleCode} onInput={(e) => setSampleCode(e.detail.value)} />
      <Input className="input grow" placeholder="物种/名称" value={species} onInput={(e) => setSpecies(e.detail.value)} />
      <Input className="input small" type="number" value={count} onInput={(e) => setCount(e.detail.value)} />
    </View>
    <View className="row">
      <Button size="mini" className="mini" onClick={addCollect}>采集样本</Button>
      <Button size="mini" className="mini" onClick={addHandover}>交接给站点</Button>
      <Button size="mini" className="mini primary-mini" onClick={sealAndEnqueue}>封包待发</Button>
    </View>
    {message && <Text className="hint">{message}</Text>}
  </View>;
}

/* ---------------- 待接收队列 ---------------- */

function QueuePanel({ queue, onIngest, onEnqueue, onRetransmit }: {
  queue: QueueItem[];
  onIngest: (item: QueueItem) => void;
  onEnqueue: (items: QueueItem[]) => void;
  onRetransmit: (item: QueueItem) => void;
}) {
  const rig = getRig();
  const prepare = (builder: () => QueueItem[] | QueueItem) => {
    const result = builder();
    onEnqueue(Array.isArray(result) ? result : [result]);
  };
  return <View className="card">
    <View className="card-title">待接收离线包<Text className="count">{queue.length} 包在队列</Text></View>
    <View className="scenario-grid">
      <button className="chip" onClick={() => prepare(() => rig.buildInitial().map((item) => ({ ...item, uid: `q-${++uidCounter}` })))}>准备：拆包+多设备去重</button>
      <button className="chip" onClick={() => prepare(() => ({ uid: `q-${++uidCounter}`, ...rig.buildClockRollbackPackage() }))}>准备：时间回拨+单条失败</button>
      <button className="chip" onClick={() => prepare(() => ({ uid: `q-${++uidCounter}`, ...rig.buildReplayAndLatePackage() }))}>准备：旧事件补发包晚到</button>
      <button className="chip" onClick={() => prepare(() => ({ uid: `q-${++uidCounter}`, ...rig.buildSampleTransfer() }))}>准备：样本转运</button>
      <button className="chip warn-chip" onClick={() => prepare(() => ({ uid: `q-${++uidCounter}`, ...rig.buildLateHandoverAfterReturn() }))}>准备：退回后旧交接晚到</button>
      <button className="chip" onClick={() => prepare(() => ({ uid: `q-${++uidCounter}`, ...rig.buildLabSend() }))}>准备：补齐后送检</button>
    </View>
    {queue.length === 0 && <Text className="hint">没有待接收包。点上方按钮构造场景，或在设备端录入后“封包待发”。</Text>}
    {queue.map((item) => <View className="queue-row" key={item.uid}>
      <View className="queue-info">
        <Text className="queue-label">{item.label}</Text>
        <Text className="muted mono">{item.pkg.deviceId} · 包序号 {item.pkg.packageSeq} · 事件序号 {item.pkg.events.map((e) => e.seq).join(', ')}</Text>
      </View>
      <View className="queue-actions">
        <Button size="mini" className="primary-mini" onClick={() => onIngest(item)}>联网接收</Button>
        {item.retransmitFrom && item.retransmitSeq !== undefined &&
          <Button size="mini" onClick={() => onRetransmit(item)}>整包重传</Button>}
      </View>
    </View>)}
  </View>;
}

/* ---------------- 接收报告（逐条结果） ---------------- */

/** 演示用：按失败原因码自动修正事件原文，再封一个新包重传（失败不锁死）。 */
function repairEvent(event: PackageEvent, reasonCode: string | undefined): PackageEvent {
  const fixed = structuredClone(event);
  if (fixed.kind === 'observation' && reasonCode === 'EMPTY_NOTE') {
    fixed.note = '修正补记：原条目内容为空，现场补录为溪沟巡查无异常';
  }
  if (fixed.kind === 'track' && reasonCode === 'INVALID_COORDS') {
    fixed.latitude = 30.584; fixed.longitude = 103.22;
  }
  if (fixed.kind === 'collect') {
    if (reasonCode === 'EMPTY_SAMPLE_CODE') fixed.sampleCode = `SMP-FIX-${fixed.seq}`;
    if (reasonCode === 'INVALID_COUNT') fixed.count = 1;
    if (reasonCode === 'MISSING_COLLECTOR') {
      fixed.collectorId = 'ranger-jia'; fixed.collectorName = '巡护员甲';
    }
  }
  if (fixed.kind === 'handover') {
    if (reasonCode === 'EMPTY_SAMPLE_CODE') fixed.sampleCode = 'SMP-A';
    if (reasonCode === 'MISSING_HANDOVER_TARGET') {
      fixed.toPersonId = 'store-wang'; fixed.toPersonName = '站点冷库王师傅';
    }
  }
  return fixed;
}

function ResultRows({ report, onRetryFailed }: {
  report: IngestReport;
  onRetryFailed: (report: IngestReport) => void;
}) {
  return <View className="report">
    <View className="report-head">
      <Text className="mono">{report.deviceId} · 包 #{report.packageSeq}</Text>
      <Text className="muted">{shortTime(report.ingestedAt)}</Text>
      {report.packageReplayed && <Text className="tag replay">整包重传·沿用首次报告</Text>}
    </View>
    {report.packageWarnings.map((warning, index) =>
      <View className="warning" key={index}><Text>⚠ {warning.message}</Text></View>)}
    {report.results.map((result) => <View className={`result ${STATUS_CLASS[result.status]}`} key={result.eventId}>
      <View className="result-main">
        <Text className="result-status">{statusLabel(result.status)}</Text>
        <Text className="result-kind">{kindLabel(result.kind)} · seq {result.seq}</Text>
        <Text className="result-msg">{result.message}</Text>
      </View>
      {result.status === 'failed' && <Text className="reason">原因码：{result.reasonCode}</Text>}
      {result.requiredMaterials && result.requiredMaterials.length > 0 &&
        <View className="materials">待补材料：{result.requiredMaterials.map((material) =>
          <Text className="tag material" key={material}>{material}</Text>)}</View>}
    </View>)}
    {!report.packageReplayed && report.failedEvents && report.failedEvents.length > 0 &&
      <Button size="mini" className="mini" onClick={() => onRetryFailed(report)}>
        修正失败条目并补包重传（{report.failedEvents.length} 条）
      </Button>}
  </View>;
}

function kindLabel(kind: ItemResult['kind']): string {
  return { observation: '观察', track: '轨迹', collect: '样本采集', handover: '样本交接' }[kind];
}

function ReportsPanel({ onRetryFailed }: { onRetryFailed: (report: IngestReport) => void }) {
  const reports = useSelector((root: RootState) => root.patrol.engine.reports);
  return <View className="card">
    <View className="card-title">接收报告<Text className="count">每条结果 / 失败原因 / 待补材料</Text></View>
    {reports.length === 0 && <Text className="hint">还没有接收过离线包。</Text>}
    <ScrollView scrollY className="report-list">
      {reports.map((report) => <ResultRows key={report.id} report={report} onRetryFailed={onRetryFailed} />)}
    </ScrollView>
  </View>;
}

/* ---------------- 负责人复核：观察 ---------------- */

function ObservationReviewCard({ obsKey }: { obsKey: string }) {
  const dispatch = useDispatch();
  const obs = useSelector((root: RootState) => root.patrol.engine.observations.find((item) => item.key === obsKey)!);
  const tracks = useSelector((root: RootState) => root.patrol.engine.tracks);
  const reviews = useSelector((root: RootState) =>
    root.patrol.engine.reviews.filter((item) => item.target === 'observation' && item.refKey === obsKey));
  const flags = detectFlags(obs, tracks);
  const suggested = flagReasons(flags);
  const [materials, setMaterials] = useState('');
  const latest = reviews[reviews.length - 1];

  const decide = (verdict: 'approved' | 'returned') => {
    dispatch(review({
      obsKey, verdict, reviewer: '负责人冯站长',
      reasons: verdict === 'returned' ? suggested : ['复核通过'],
      requiredMaterials: verdict === 'returned' ? materials.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
    }));
    setMaterials('');
  };

  return <View className={`review-card ${latest?.verdict === 'returned' ? 'returned' : ''}`}>
    <View className="review-head">
      <Text className={`risk-badge r-${obs.risk}`}>{obs.risk === 'high' ? '高' : obs.risk === 'medium' ? '中' : '低'}风险</Text>
      <Text className="review-note">{obs.note}</Text>
    </View>
    <Text className="muted mono small">{obs.deviceId} · seq {obs.seq} · 设备时间 {shortTime(obs.deviceTime)}</Text>
    <View className="flag-row">
      <Text className={obs.outOfCapability ? 'flag on' : 'flag'}>能力{obs.outOfCapability ? '超范围' : '范围内'}</Text>
      <Text className={flags.location ? 'flag on' : 'flag'}>位置{flags.location ? '异常' : '正常'}</Text>
      <Text className={flags.missingEvidence ? 'flag on' : 'flag'}>证据{flags.missingEvidence ? '缺失' : '已附'}</Text>
    </View>
    {suggested.length > 0 && <Text className="hint">初判：{suggested.join('；')}</Text>}
    <View className="review-actions">
      <Input className="input grow" placeholder="退回需补的材料，逗号分隔" value={materials} onInput={(e) => setMaterials(e.detail.value)} />
      <Button size="mini" onClick={() => decide('returned')}>退回</Button>
      <Button size="mini" className="primary-mini" onClick={() => decide('approved')}>通过</Button>
    </View>
    {reviews.length > 0 && <View className="history">
      <Text className="muted small">复核历史（只追加，旧结论不会被旧包顶掉）：</Text>
      {reviews.map((review) => <Text className="history-line" key={review.id}>
        第 {review.revision} 次 · {review.verdict === 'approved' ? '通过' : '退回'} · {review.reasons.join('；')}
        {review.requiredMaterials.length > 0 ? ` · 待补：${review.requiredMaterials.join('、')}` : ''}
      </Text>)}
    </View>}
  </View>;
}

function ReviewPanel() {
  const observations = useSelector((root: RootState) => root.patrol.engine.observations);
  const ordered = [...observations].sort((a, b) => b.receivedOrder - a.receivedOrder);
  return <View className="card">
    <View className="card-title">负责人复核 · 观察<Text className="count">按能力范围 / 位置异常 / 缺失证据</Text></View>
    {observations.length === 0 && <Text className="hint">暂无观察记录。</Text>}
    {ordered.map((obs) => <ObservationReviewCard key={obs.key} obsKey={obs.key} />)}
  </View>;
}

/* ---------------- 样本与交接链 ---------------- */

function ChainType({ entry }: { entry: CustodyEntry }) {
  const label = { collect: '采集', handover: '交接', void: entry.reviewId?.startsWith('return') ? '退回点' : '作废', resume: '补齐续点' }[entry.type];
  return <Text className={`chain-type t-${entry.type}`}>{label}</Text>;
}

function SampleCard({ sampleCode }: { sampleCode: string }) {
  const dispatch = useDispatch();
  const sample = useSelector((root: RootState) => root.patrol.engine.samples.find((item) => item.sampleCode === sampleCode)!);
  const chain = useSelector((root: RootState) =>
    root.patrol.engine.custody.filter((entry) => entry.sampleCode === sampleCode));
  const active = useSelector((root: RootState) => root.patrol.engine.activeReturns[sampleCode]);
  const reviews = useSelector((root: RootState) =>
    root.patrol.engine.reviews.filter((item) => item.target === 'sample' && item.refKey === sampleCode));
  const [materials, setMaterials] = useState('封签补拍照,双人签字单');
  const [supplement, setSupplement] = useState('封签补拍照,双人签字单');
  const chainOk = verifyChain({ custody: chain } as never, sampleCode).ok;

  return <View className={`sample-card ${active ? 'returned' : ''}`}>
    <View className="sample-head">
      <Text className="sample-code mono">{sample.sampleCode}</Text>
      {sample.legacy && <Text className="tag legacy">升级前旧记录</Text>}
      {active && <Text className="tag void-tag">退回中</Text>}
      <Text className={chainOk ? 'chain-verify ok' : 'chain-verify bad'}>{chainOk ? '链完整 ✓' : '链已被篡改 ✗'}</Text>
    </View>
    <Text className="muted">{sample.species} × {sample.count} · 采集人：{sample.collectorName} · 采集时间：{shortTime(sample.collectedAt)}</Text>

    <View className="chain">
      {[...chain].sort((a, b) => a.chainSeq - b.chainSeq).map((entry) => <View className="chain-row" key={entry.eventId}>
        <Text className="chain-seq">#{entry.chainSeq}</Text>
        <ChainType entry={entry} />
        <View className="chain-body">
          {entry.type === 'collect' && <Text>采集人 {entry.collectorName}{entry.legacy ? '（旧设备，仅保留采集人与时间）' : ''}</Text>}
          {entry.type === 'handover' && <Text>{entry.fromPersonId} → {entry.toPersonName}（{entry.destination}）</Text>}
          {entry.type === 'void' && <Text>{entry.reason}</Text>}
          {entry.type === 'resume' && <Text>补齐续点：{entry.resumeNote}</Text>}
          <Text className="muted small mono">{entry.deviceId} · seq {entry.deviceSeq} · {shortTime(entry.deviceTime)}
            {entry.evidenceIds.length > 0 ? ` · 凭证 ${entry.evidenceIds.length} 份` : ' · 无凭证'}</Text>
        </View>
      </View>)}
    </View>

    {active && <View className="return-box">
      <Text className="hint">退回原因：{active.reasons.join('；')}</Text>
      <Text className="hint">待补材料：{active.requiredMaterials.join('、')}</Text>
      <View className="review-actions">
        <Input className="input grow" value={supplement} onInput={(e) => setSupplement(e.detail.value)} />
        <Button size="mini" className="primary-mini" onClick={() => {
          dispatch(resumeSampleAction({
            sampleCode, reviewer: '负责人冯站长', note: '现场补交材料',
            supplementaryEvidence: supplement.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
          }));
        }}>材料补齐·从退回点继续</Button>
      </View>
    </View>}

    {reviews.length === 0 && <View className="review-actions">
      <Input className="input grow" placeholder="退回时要求补的材料" value={materials} onInput={(e) => setMaterials(e.detail.value)} />
      <Button size="mini" onClick={() => dispatch(returnSampleAction({
        sampleCode, reviewer: '负责人冯站长',
        reasons: ['复核发现封签证据不完整'],
        requiredMaterials: materials.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      }))}>负责人退回本样本</Button>
      <Button size="mini" onClick={() => dispatch(tamperHistory({ sampleCode, chainSeq: 1 }))} className="danger">演示：篡改#1</Button>
    </View>}
  </View>;
}

function SamplesPanel() {
  const dispatch = useDispatch();
  const samples = useSelector((root: RootState) => root.patrol.engine.samples);
  const rig = getRig();
  return <View className="card">
    <View className="card-title">样本交接链<Text className="count">采集 → 转运 → 送检 · 只追加不可改</Text></View>
    <Button size="mini" className="mini" onClick={() => dispatch(importLegacy(rig.legacySample))}>
      导入升级前旧记录（仅采集人+时间）
    </Button>
    {samples.length === 0 && <Text className="hint">暂无样本。</Text>}
    {samples.map((sample) => <SampleCard key={sample.sampleCode} sampleCode={sample.sampleCode} />)}
  </View>;
}

/* ---------------- 主页面 ---------------- */

export default function Index() {
  const dispatch = useDispatch();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const stats = useSelector((root: RootState) => ({
    observations: root.patrol.engine.observations.length,
    tracks: root.patrol.engine.tracks.length,
    samples: root.patrol.engine.samples.length,
    returned: Object.keys(root.patrol.engine.activeReturns).length,
    failed: root.patrol.engine.reports.reduce(
      (sum, report) => sum + report.results.filter((result) => result.status === 'failed').length, 0)
  }));

  const enqueue = (items: QueueItem[]) => setQueue((prev) => [...prev, ...items]);
  const ingestOne = (item: QueueItem) => {
    dispatch(ingest(structuredClone(item.pkg)));
    setQueue((prev) => prev.filter((q) => q.uid !== item.uid));
  };
  const retransmit = (item: QueueItem) => {
    if (!item.retransmitFrom || item.retransmitSeq === undefined) return;
    const rig = getRig();
    const pkg = rig.retransmit(item.retransmitFrom, item.retransmitSeq);
    dispatch(ingest(pkg));
    setQueue((prev) => prev.filter((q) => q.uid !== item.uid));
  };
  // 失败条目修正重传：只把失败事件原文修补后封一个新的补发包（seq 不变，eventId 不变）。
  const retryFailed = (report: IngestReport) => {
    const device = getRig().deviceA.deviceId === report.deviceId ? getRig().deviceA : getRig().deviceB;
    const reasonOf = (seq: number) =>
      report.results.find((result) => result.seq === seq && result.status === 'failed')?.reasonCode;
    const fixedEvents = (report.failedEvents ?? []).map((event) => repairEvent(event, reasonOf(event.seq)));
    const fixPkg: OfflinePackage = {
      patrolId: report.patrolId,
      deviceId: report.deviceId,
      deviceLabel: device.deviceLabel,
      packageSeq: device.currentPackageSeq + 1,
      lastEventSeq: Math.max(...fixedEvents.map((event) => event.seq)),
      sentAt: new Date().toISOString(),
      events: fixedEvents
    };
    dispatch(ingest(fixPkg));
  };
  const reset = () => {
    dispatch(resetAll());
    resetRig();
    setQueue([]);
  };

  const metrics = useMemo(() => [
    ['观察', stats.observations], ['轨迹点', stats.tracks], ['样本', stats.samples],
    ['退回中', stats.returned], ['累计失败', stats.failed, stats.failed > 0]
  ] as const, [stats]);

  return <View className="page">
    <Header onReset={reset} />
    <View className="metrics">
      {metrics.map(([label, value, warn]) =>
        <View className="metric-box" key={label}><Text>{label}</Text><Text className={`metric${warn ? ' warn' : ''}`}>{value}</Text></View>)}
    </View>
    <FieldPanel onEnqueue={enqueue} />
    <QueuePanel queue={queue} onIngest={ingestOne} onEnqueue={enqueue} onRetransmit={retransmit} />
    <ReportsPanel onRetryFailed={retryFailed} />
    <ReviewPanel />
    <SamplesPanel />
    <View className="footnote muted">单条失败不影响同包其他条目；观察/轨迹按业务键去重；样本退回仅作废受影响样本的后续交接；设备换人后旧记录可继续查看与交接。</View>
  </View>;
}
