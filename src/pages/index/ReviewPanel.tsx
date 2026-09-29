import { useState } from 'react';
import { Button, Text, Textarea, View } from '@tarojs/components';
import { useDispatch, useSelector } from 'react-redux';
import { addDraftSupplement, review, sendHandoff } from '../../store';
import type { RootState } from '../../store';
import { materialLabel } from '../../patrol/ingest';
import { latestReview, orderedObservations, voidedIds } from '../../patrol/selectors';
import type { MissingMaterial } from '../../patrol/types';

const REVIEWER = '周站长';
const MATERIALS: MissingMaterial[] = ['photo', 'sample_photo', 'location', 'id_note', 'capability_report', 'detail_note'];

function activeStage(state: RootState['patrol'], code: string): 'collect' | 'handover' | 'inspect' | 'done' {
  const voids = voidedIds(state);
  const active = state.segments.filter((s) => s.sampleCode === code && !voids.has(s.id));
  if (!active.some((s) => s.stage === 'handover')) return active.some((s) => s.stage === 'collect') ? 'collect' : 'done';
  if (!active.some((s) => s.stage === 'inspect')) return 'handover';
  return 'done';
}

function ReviewBadge({ state, targetType, targetKey }: { state: RootState['patrol']; targetType: 'observation' | 'sample'; targetKey: string }) {
  const r = latestReview(state, targetType, targetKey);
  if (!r) return <Text className="muted">未复核</Text>;
  return (
    <Text className={r.status === 'returned' ? 'pill err' : 'pill ok'}>
      {r.status === 'returned' ? `已退回 v${r.version}` : `已核准 v${r.version}`}
      {r.status === 'returned' && r.missing.length ? ` · 缺 ${r.missing.map(materialLabel).join('、')}` : ''}
    </Text>
  );
}

export function ReviewPanel() {
  const dispatch = useDispatch();
  const state = useSelector((r: RootState) => r.patrol);
  const [supTarget, setSupTarget] = useState<{ type: 'observation' | 'sample'; key: string } | null>(null);
  const [materials, setMaterials] = useState<MissingMaterial[]>([]);
  const [note, setNote] = useState('');

  const observations = orderedObservations(state);
  const samples = Object.values(state.samples);

  const submitSupplement = () => {
    if (supTarget && materials.length) {
      dispatch(addDraftSupplement({ targetType: supTarget.type, targetKey: supTarget.key, materials, note: note || '现场补齐材料' }));
      setSupTarget(null); setMaterials([]); setNote('');
    }
  };

  return (
    <View>
      <View className="card">
        <View className="card-title">负责人复核：能力范围 / 位置异常 / 缺失证据</View>
        <Text className="hint">退回只作废受影响样本的后续交接（交接、送检），采集段保留；结论版本化，迟到旧包顶不掉。</Text>
        {observations.map((o) => (
          <View className="row" key={o.key}>
            <View className="row-main">
              <Text className="row-title">{o.risk === 'high' ? '高风险 · ' : ''}{o.note}{o.legacy && <Text className="legacy-tag"> 旧机</Text>}</Text>
              <Text className="muted">{o.at} · {o.collector} · {o.evidencePhoto ? '有照片' : '缺照片'} · {o.withinCapability ? '能力内' : '超能力'} · {o.latitude !== undefined ? `位置 ${o.latitude.toFixed(3)}` : '无位置'}</Text>
              <View className="row-actions"><ReviewBadge state={state} targetType="observation" targetKey={o.key} /></View>
            </View>
            <View className="btn-stack">
              <Button size="mini" className="ok-btn" onClick={() => dispatch(review({ targetType: 'observation', targetKey: o.key, status: 'approved', reviewer: REVIEWER, note: '证据齐全，位置合理，能力范围内' }))}>核准</Button>
              <Button size="mini" onClick={() => dispatch(review({ targetType: 'observation', targetKey: o.key, status: 'returned', reviewer: REVIEWER, note: '证据/能力/位置不满足，退回补材料' }))}>退回</Button>
              <Button size="mini" onClick={() => { setSupTarget({ type: 'observation', key: o.key }); setMaterials([]); }}>补材料</Button>
            </View>
          </View>
        ))}
      </View>

      <View className="card">
        <View className="card-title">样本核验与逐段交接</View>
        {samples.map((s) => {
          const stage = activeStage(state, s.code);
          const nextLabel = stage === 'collect' ? '交接 → 站点冷柜' : stage === 'handover' ? '送检 → 实验室' : null;
          return (
            <View className="sample-block" key={s.code}>
              <View className="row">
                <View className="row-main">
                  <Text className="row-title">{s.code} · {s.species} × {s.count}{s.legacy && <Text className="legacy-tag"> 旧机</Text>}</Text>
                  <Text className="muted">采集 {s.collectedAt} · {s.collector} · {s.state === 'returned' ? '退回中（仅采集段有效）' : '流转中'}</Text>
                  <ReviewBadge state={state} targetType="sample" targetKey={s.code} />
                </View>
                <View className="btn-stack">
                  <Button size="mini" className="ok-btn" onClick={() => dispatch(review({ targetType: 'sample', targetKey: s.code, status: 'approved', reviewer: REVIEWER, note: '样本核验通过，可继续流转' }))}>核验通过</Button>
                  <Button size="mini" onClick={() => dispatch(review({ targetType: 'sample', targetKey: s.code, status: 'returned', reviewer: REVIEWER, note: '证据不足退回，作废后续交接，补齐后从退回点继续' }))}>退回</Button>
                  <Button size="mini" onClick={() => { setSupTarget({ type: 'sample', key: s.code }); setMaterials([]); }}>补材料</Button>
                  {nextLabel && (
                    <Button size="mini" className={s.state === 'returned' ? '' : 'ok-btn'} disabled={s.state === 'returned'}
                      onClick={() => dispatch(sendHandoff({ sampleCode: s.code, stage: stage === 'collect' ? 'handover' : 'inspect', to: stage === 'collect' ? '站点冷柜' : '实验室', note: stage === 'collect' ? '站点交接' : '送检登记' }))}>
                      {s.state === 'returned' ? '退回中，先补齐核准' : nextLabel}
                    </Button>
                  )}
                </View>
              </View>
            </View>
          );
        })}
      </View>

      {supTarget && (
        <View className="card modal-card">
          <View className="card-title">补齐材料：{supTarget.key}</View>
          <View className="checks">
            {MATERIALS.map((m) => (
              <label key={m}><input type="checkbox" checked={materials.includes(m)}
                onChange={(e) => setMaterials(e.target.checked ? [...materials, m] : materials.filter((x) => x !== m))} /> {materialLabel(m)}</label>
            ))}
          </View>
          <Textarea className="textarea" placeholder="补充说明" value={note} onInput={(e) => setNote(e.detail.value)} />
          <View className="two">
            <Button className="secondary" onClick={() => setSupTarget(null)}>取消</Button>
            <Button className="primary" disabled={materials.length === 0} onClick={submitSupplement}>加入草稿包（封包同步后生效，从退回点继续）</Button>
          </View>
        </View>
      )}
    </View>
  );
}
