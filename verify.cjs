/* 运行时冒烟验证：node -r @swc/register verify.cjs */
const assert = require('assert');
const { createSeedState } = require('./src/patrol/seed.ts');
const { produce } = require('immer');
const { processPacket, submitReview, deviceNow } = require('./src/patrol/ingest.ts');

const s0 = createSeedState();

// 1. 种子：多设备拆包、观察/轨迹去重
const r21 = s0.receipts.find((r) => r.packetId === 'PK-D-02-1');
assert.ok(r21.entries.every((e) => e.status === 'duplicate'), 'D-02#1 两条都应判重');

// 2. 时间回拨告警存在（按序号排序不按时间）
assert.ok(s0.tracks.some((t) => t.flagReason && t.flagReason.includes('回拨')), '应标记时间回拨');

// 3. WD-0929-07：采集段保留，交接段已作废
const voidSegs = s0.segments.filter((seg) => s0.voids.some((v) => v.segmentId === seg.id));
assert.strictEqual(voidSegs.length, 1);
assert.strictEqual(voidSegs[0].stage, 'handover');
assert.strictEqual(s0.samples['WD-0929-07'].state, 'returned');

// 4. 退回后不能继续交接（返回状态）
assert.strictEqual(s0.samples['WD-0929-01'].state, 'active');

// 5. 待同步 D-01#4 处理：未知样本交接失败、其他条目照常
let s = s0;
const p14 = s.outbound.find((p) => p.id === 'PK-D-01-4');
const before = { obs: s.observations.length };
s = produce(s, (d) => { processPacket(d, d.outbound.find((p) => p.id === 'PK-D-01-4')); });
const receipt14 = s.receipts.find((r) => r.packetId === 'PK-D-01-4');
assert.strictEqual(receipt14.summary.rejected, 1, '未知样本交接应失败');
assert.strictEqual(receipt14.summary.accepted + receipt14.summary.warning, 2, '另外两条应照常处理');
assert.strictEqual(s.observations.length, before.obs + 1, '高风险观察应已入库（带待复核）');
const failEntry = receipt14.entries.find((e) => e.status === 'rejected');
assert.ok(failEntry.reason.includes('尚未入库'));

// 6. 缺包检测：水位 D-01 是 2，#4 先到应记录缺口 [3]
assert.deepStrictEqual(receipt14.gap, [3]);

// 7. 重传沿用第一次结果
const firstJson = JSON.stringify(receipt14);
s = produce(s, (d) => { const pk = d.outbound.find((p) => p.id === 'PK-D-01-4'); pk.sentCount += 1; processPacket(d, pk); });
const second = s.receipts.filter((r) => r.packetId === 'PK-D-01-4').length;
assert.strictEqual(second, 1, '重传不产生新回执');
assert.strictEqual(JSON.stringify(s.receipts.find((r) => r.packetId === 'PK-D-01-4')), firstJson, '结果逐字节不变');

// 8. 迟到的旧包（seq<=水位）不顶结论：先核准 D-01#2 观察，再重放
const obsKey = s.observations.find((o) => o.note.includes('红外相机')).key;
s = produce(s, (d) => { submitReview(d, { targetType: 'observation', targetKey: obsKey, status: 'approved', reviewer: '周站长', note: '先核准' }); });
s = produce(s, (d) => { const pk = d.outbound.find((p) => p.id === 'PK-D-01-2'); pk.sentCount += 1; processPacket(d, pk); });
assert.strictEqual(s.reviewHistory.filter((r) => r.targetKey === obsKey).length, 1, '旧包重放不改复核');
assert.strictEqual(s.reviews[`rev_observation_${obsKey}`].status, 'approved');

// 9. 补齐材料 → 复核版本升级 → 样本重新交接成功
s = produce(s, (d) => {
  const dev = d.devices['D-03'];
  dev.lastSeq += 1;
  const ord = dev.nextOrdinal++;
  d.outbound.push({
    id: `PK-D-03-${dev.lastSeq}`, deviceId: 'D-03', patrolId: d.patrolId, seq: dev.lastSeq,
    sealedAt: deviceNow(0), clockOffsetMin: 0, status: 'pending', sentCount: 1,
    entries: [{ id: `e-D-03-${ord}`, ordinal: ord, kind: 'supplement', at: deviceNow(0), collector: '赵巡护',
      targetType: 'sample', targetKey: 'WD-0929-07', materials: ['sample_photo'], note: '补拍样本照片' }]
  });
  processPacket(d, d.outbound[d.outbound.length - 1]);
  submitReview(d, { targetType: 'sample', targetKey: 'WD-0929-07', status: 'approved', reviewer: '周站长', note: '材料齐，恢复流转' });
  const ord2 = dev.nextOrdinal++; dev.lastSeq += 1;
  const handPacket = {
    id: `PK-D-03-${dev.lastSeq}`, deviceId: 'D-03', patrolId: d.patrolId, seq: dev.lastSeq,
    sealedAt: deviceNow(0), clockOffsetMin: 0, status: 'pending', sentCount: 1,
    entries: [{ id: `e-D-03-${ord2}`, ordinal: ord2, kind: 'handoff', at: deviceNow(0), collector: '赵巡护',
      sampleCode: 'WD-0929-07', stage: 'handover', to: '站点冷柜', note: '补齐后重新交接' }]
  };
  d.outbound.push(handPacket);
  const hr = processPacket(d, handPacket);
  assert.strictEqual(hr.entries[0].status, 'accepted', '补齐核准后应能从退回点重新交接');
});
const segChain = s.segments.filter((x) => x.sampleCode === 'WD-0929-07').sort((a, b) => a.ordinal - b.ordinal);
assert.strictEqual(segChain.length, 3, '采集-旧交接(作废)-新交接');
const newest = segChain[segChain.length - 1];
assert.ok(newest.hash !== newest.prevHash && newest.prevHash === segChain[1].hash, '新交接链接在链尾（作废段仍保留在哈希链上，只做作废标记）');

// 10. 重复同阶段交接被拒
s = produce(s, (d) => {
  const dev = d.devices['D-01'];
  const ord = dev.nextOrdinal++; dev.lastSeq += 1;
  const pkt = {
    id: `PK-D-01-${dev.lastSeq}`, deviceId: 'D-01', patrolId: d.patrolId, seq: dev.lastSeq,
    sealedAt: deviceNow(0), clockOffsetMin: 0, status: 'pending', sentCount: 1,
    entries: [{ id: `e-D-01-${ord}`, ordinal: ord, kind: 'handoff', at: deviceNow(0), collector: '李巡护',
      sampleCode: 'WD-0929-01', stage: 'handover', to: '站点冷柜' }]
  };
  d.outbound.push(pkt);
  const rr = processPacket(d, pkt);
  assert.strictEqual(rr.entries[0].status, 'rejected', '同阶段交接不可重复');
});

console.log('OK 全部规则验证通过');
