import { Text, View } from '@tarojs/components';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { orderedSegments, orderedTracks, shortHash, voidReason, voidedIds } from '../../patrol/selectors';
import { materialLabel, stageLabel } from '../../patrol/ingest';

export function RecordsPanel() {
  const state = useSelector((r: RootState) => r.patrol);
  const voids = voidedIds(state);
  const tracks = orderedTracks(state);
  const observations = [...state.observations].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <View>
      <View className="card">
        <View className="card-title">样本交接台账（逐段 · 不可改 · 哈希链）</View>
        <Text className="hint">作废不删记录：退回只把后续段标记作废，补齐后新段接在链尾继续。</Text>
        {Object.values(state.samples).map((s) => (
          <View className="sample-block" key={s.code}>
            <Text className="row-title">{s.code} · {s.species}{s.legacy ? ' · 旧机（仅采集人与时间）' : ''}</Text>
            {orderedSegments(state, s.code).map((seg) => {
              const isVoid = voids.has(seg.id);
              return (
                <View className={isVoid ? 'chain void' : 'chain'} key={seg.id}>
                  <View className="chain-head">
                    <Text className={`pill ${isVoid ? 'err' : 'ok'}`}>{isVoid ? '已作废' : '有效'}</Text>
                    <Text className="chain-stage">{stageLabel(seg.stage)}段 · {seg.at} · {seg.actor}{seg.to ? ` → ${seg.to}` : ''}</Text>
                  </View>
                  <Text className="muted">{seg.note ?? ''}</Text>
                  <Text className="muted hash">#{seg.ordinal} · 链 {shortHash(seg.prevHash)} → {shortHash(seg.hash)}（内容不可修改）</Text>
                  {isVoid && <Text className="missing">作废原因：{voidReason(state, seg.id)}</Text>}
                </View>
              );
            })}
          </View>
        ))}
      </View>

      <View className="card">
        <View className="card-title">轨迹（按设备内序号排序）<Text className="count">{tracks.length} 点</Text></View>
        {tracks.map((t) => (
          <View className="row" key={t.key}>
            <View>
              <Text className="row-title">#{t.ordinal} {t.latitude.toFixed(4)}, {t.longitude.toFixed(4)} · {t.source}</Text>
              <Text className="muted">设备时间 {t.at} · {t.deviceId}</Text>
              {t.flagReason && <Text className="missing">⚠ {t.flagReason}</Text>}
            </View>
          </View>
        ))}
      </View>

      <View className="card">
        <View className="card-title">已入库观察（业务键去重）</View>
        {observations.map((o) => (
          <View className="row" key={o.key}>
            <View>
              <Text className="row-title">#{o.ordinal} {o.note}{o.legacy && <Text className="legacy-tag"> 旧机</Text>}</Text>
              <Text className="muted">{o.at} · {o.collector} · {o.deviceId} · 键 {o.key.slice(0, 12)}</Text>
            </View>
          </View>
        ))}
      </View>

      <View className="card">
        <View className="card-title">补材料与复核版本</View>
        {state.supplements.length === 0 && <Text className="muted">暂无补充记录</Text>}
        {state.supplements.map((s) => (
          <View className="row" key={s.id}><View>
            <Text className="row-title">{s.targetType === 'sample' ? '样本' : '观察'} {s.targetKey}：{s.materials.map(materialLabel).join('、')}</Text>
            <Text className="muted">{s.at} · {s.collector} · {s.note}</Text>
          </View></View>
        ))}
        {state.reviewHistory.slice().reverse().map((r) => (
          <View className="row" key={`${r.key}-${r.version}`}><View>
            <Text className="row-title">{r.targetType === 'sample' ? '样本' : '观察'} {r.targetKey.slice(0, 16)} · {r.status === 'returned' ? '退回' : '核准'} v{r.version}</Text>
            <Text className="muted">{r.at} · {r.reviewer} · 能力{r.capability ? '✓' : '✗'} 位置{r.location ? '✓' : '✗'} 证据{r.evidence ? '✓' : '✗'} {r.missing.length ? `缺：${r.missing.map(materialLabel).join('、')}` : ''}</Text>
            <Text className="muted">{r.note}</Text>
          </View></View>
        ))}
      </View>

      <View className="card">
        <View className="card-title">审计日志</View>
        {state.audit.map((a) => <Text className="audit" key={a.id}>{a.at} [{a.actor}] {a.message}</Text>)}
      </View>
    </View>
  );
}
