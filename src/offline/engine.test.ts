/* eslint-disable no-console */
// 离线巡护包接收引擎自测（node 运行编译产物）。
import { createState, ingestPackage, verifyChain, detectFlags, returnSample, resumeSample, importLegacySample, latestReview, reviewObservation } from './engine';
import { DemoRig } from './demoRig';

let failures = 0;
function check(name: string, cond: boolean | undefined, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

function run() {
  console.log('1) 拆包 + 跨设备去重');
  const rig = new DemoRig();
  let state = createState(rig.patrolId);
  const initial = rig.buildInitial();
  let r1 = ingestPackage(state, initial[0].pkg); state = r1.state;
  let r2 = ingestPackage(state, initial[1].pkg); state = r2.state;
  let r3 = ingestPackage(state, initial[2].pkg); state = r3.state;
  check('A1 三条全部 applied', r1.report.results.every((r) => r.status === 'applied'));
  check('B1 观察被业务键去重', r2.report.results.some((r) => r.kind === 'observation' && r.status === 'skipped'));
  check('B1 轨迹（不同设备）正常入库', r2.report.results.some((r) => r.kind === 'track' && r.status === 'applied'));
  check('观察只入库一条', state.observations.length === 1, `got ${state.observations.length}`);
  check('轨迹按设备区分共 3 条', state.tracks.length === 3, `got ${state.tracks.length}`);
  check('样本与交接已建立', state.samples.length === 1 && state.custody.filter((c) => c.type !== 'void').length === 2);

  console.log('2) 整包重传沿用第一次结果');
  const again = ingestPackage(state, rig.retransmit('A', 2)); state = again.state;
  check('报告标记为包重放', again.report.packageReplayed === true);
  check('整包重传沿用首次报告（条目首次状态保持 applied）', again.report.results.every((r) => r.status === 'applied'));
  check('没有新增交接记录', state.custody.filter((c) => c.type === 'handover').length === 1);

  console.log('3) 时间回拨 + 单条失败不影响其他');
  const rollback = rig.buildClockRollbackPackage();
  const rr = ingestPackage(state, rollback.pkg); state = rr.state;
  check('有空观察失败条目', rr.report.results.some((r) => r.status === 'failed' && r.reasonCode === 'EMPTY_NOTE'));
  check('同包其他条目照常 applied', rr.report.results.filter((r) => r.status === 'applied').length === 3);
  check('时钟回拨告警', rr.report.packageWarnings.some((w) => w.code === 'CLOCK_ROLLBACK'));
  check('事件未按时间排序错乱（回拨后的套索观察 seq3 仍排在 A 的 seq2 之后入库）',
    state.observations.map((o) => `${o.deviceId}:${o.seq}`).join(',') === 'DEV-A11:2,DEV-B22:3');

  console.log('4) 旧包晚到 + 单事件重传沿用，改写内容不能顶掉结论');
  const late = rig.buildReplayAndLatePackage();
  const rl = ingestPackage(state, late.pkg); state = rl.state;
  const replayedItem = rl.report.results.find((r) => r.seq === 3);
  check('seq3 沿用第一次结果', replayedItem?.status === 'replayed');
  check('seq7 照常入库', rl.report.results.some((r) => r.seq === 7 && r.status === 'applied'));
  check('补发包缺口告警', rl.report.packageWarnings.some((w) => w.code === 'EVENT_GAP' || w.code === 'PACKAGE_GAP'));
  check('旧包改写的高风险结论未生效', state.observations.find((o) => o.deviceId === 'DEV-B22' && o.seq === 3)?.risk === 'high');
  check('观察内容没有被旧包覆盖', state.observations.find((o) => o.deviceId === 'DEV-B22' && o.seq === 3)?.note.includes('套索') === true);

  console.log('4b) 失败条目不锁死：修正内容后重传可成功');
  {
    const fixed = structuredClone(rollback.pkg);
    fixed.packageSeq = 21;
    fixed.sentAt = new Date().toISOString();
    fixed.events = [structuredClone(fixed.events.find((e) => e.seq === 4)!)];
    if (fixed.events[0].kind === 'observation') fixed.events[0].note = '补记：溪沟水量正常';
    const retry = ingestPackage(state, fixed); state = retry.state;
    const item = retry.report.results.find((r) => r.seq === 4)!;
    check('原失败事件修正后重传为 applied', item.status === 'applied');
    check('重传包没有其他失败条目', retry.report.results.every((r) => r.status !== 'failed'));
  }

  console.log('5) 负责人复核只追加，旧结论不被顶掉');
  {
    const obsKey = state.observations.find((o) => o.note.includes('套索') && o.risk === 'high')!.key;
    const flags = detectFlags(state.observations.find((o) => o.key === obsKey)!, state.tracks);
    check('位置异常初判不触发（有定位且轨迹邻近）', flags.location === false);
    reviewObservation(state, {
      obsKey, verdict: 'returned', reviewer: '负责人冯站长',
      reasons: ['证据缺失：套索近景照片不够清晰'], requiredMaterials: ['套索近景照片', '处置记录'],
    });
    const first = latestReview(state, 'observation', obsKey)!;
    check('第一次复核为退回', first.verdict === 'returned' && first.revision === 1);
    // 旧包再到（seq2 replayed），不应产生新结论也不改旧结论
    ingestPackage(state, rig.retransmit('B', 2));
    check('重传后退回结论仍在', latestReview(state, 'observation', obsKey)?.id === first.id);
    reviewObservation(state, {
      obsKey, verdict: 'approved', reviewer: '负责人冯站长', reasons: ['材料已补齐'], requiredMaterials: [],
    });
    check('第二次复核 revision=2 且为通过', latestReview(state, 'observation', obsKey)!.revision === 2 &&
      latestReview(state, 'observation', obsKey)!.verdict === 'approved');
    check('两条结论都保留（只追加）', state.reviews.filter((v) => v.refKey === obsKey).length === 2);
  }

  console.log('6) 样本退回：仅作废受影响样本的后续交接，补齐后从退回点继续');
  const t1 = ingestPackage(state, rig.buildSampleTransfer().pkg); state = t1.state;
  check('正常转运入库', t1.report.results[0].status === 'applied');
  returnSample(state, {
    sampleCode: 'SMP-A', reviewer: '负责人冯站长',
    reasons: ['封签照片不完整'], requiredMaterials: ['封签补拍照', '双人签字单'],
  });
  check('退回点已入链', state.custody.filter((c) => c.sampleCode === 'SMP-A' && c.type === 'void').length === 1);
  const otherSampleChainOk = state.custody.filter((c) => c.sampleCode === 'SMP-D').length === 1;
  check('其他样本 SMP-D 不受退回影响', otherSampleChainOk);
  const lateHandover = ingestPackage(state, rig.buildLateHandoverAfterReturn().pkg); state = lateHandover.state;
  check('退回后晚到的交接自动作废', lateHandover.report.results[0].status === 'auto-voided');
  check('作废结果带待补材料', (lateHandover.report.results[0].requiredMaterials?.length ?? 0) === 2);
  check('自动作废同样留在不可改链上', state.custody.filter((c) => c.sampleCode === 'SMP-A' && c.type === 'void').length === 2);
  resumeSample(state, {
    sampleCode: 'SMP-A', reviewer: '负责人冯站长', note: '封签与签字单补齐',
    supplementaryEvidence: ['seal-fix-1', 'sign-fix-1'],
  });
  const lab = ingestPackage(state, rig.buildLabSend().pkg); state = lab.state;
  check('补齐后送检正常入库', lab.report.results[0].status === 'applied');
  const chain = state.custody.filter((c) => c.sampleCode === 'SMP-A').map((c) => c.type);
  check('SMP-A 链顺序完整', chain.join(',') === 'collect,handover,handover,void,void,resume,handover', chain.join(','));
  check('链哈希校验通过', verifyChain(state, 'SMP-A').ok);

  console.log('7) 升级前旧记录：只有采集人和时间，仍可查看与交接');
  importLegacySample(state, rig.legacySample);
  const legacy = state.custody.find((c) => c.sampleCode === 'SMP-OLD-07')!;
  check('旧记录已入链并标记 legacy', legacy.legacy === true && (legacy.collectorName ?? '').includes('老周'));
  check('旧记录链校验通过', verifyChain(state, 'SMP-OLD-07').ok);
  check('样本列表能看到旧记录', state.samples.some((s) => s.sampleCode === 'SMP-OLD-07' && s.legacy));

  console.log('8) 篡改历史会被哈希链发现');
  legacy.destination = '被人偷偷改了去向';
  check('篡改后链校验失败', verifyChain(state, 'SMP-OLD-07').ok === false);

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  if (failures > 0) process.exit(1);
}

run();
