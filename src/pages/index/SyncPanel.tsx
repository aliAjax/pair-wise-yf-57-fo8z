import { Button, Text, View } from '@tarojs/components';
import { useDispatch, useSelector } from 'react-redux';
import { retransmit, syncAll } from '../../store';
import type { RootState } from '../../store';
import { materialLabel, statusLabel } from '../../patrol/ingest';
import type { EntryReceipt, OutboundPacket } from '../../patrol/types';

const statusClass: Record<string, string> = {
  accepted: 'ok', warning: 'warn', duplicate: 'dup', rejected: 'err', voided: 'err'
};

function ReceiptRows({ entries, fallback }: { entries: EntryReceipt[]; fallback?: OutboundPacket }) {
  if (entries.length) {
    return <>{entries.map((r) => (
      <View className="receipt" key={r.entryId}>
        <View className="receipt-head">
          <Text className={`pill ${statusClass[r.status]}`}>{statusLabel(r.status)}</Text>
          <Text className="receipt-kind">{kindLabel(r.kind)}{r.businessKey ? ` · ${r.businessKey}` : ''}</Text>
        </View>
        <Text className="muted">{r.reason}</Text>
        {r.missing && r.missing.length > 0 && <Text className="missing">待补材料：{r.missing.map(materialLabel).join('、')}</Text>}
      </View>
    ))}</>;
  }
  return <>{fallback?.entries.map((e) => (
    <View className="receipt" key={e.id}>
      <Text className="muted">#{e.ordinal} 待发送 · {kindLabel(e.kind)}</Text>
    </View>
  ))}</>;
}

function kindLabel(k: string): string {
  return ({ observation: '观察', track: '轨迹', sample: '样本', handoff: '交接', supplement: '补材料' } as Record<string, string>)[k] ?? k;
}

export function SyncPanel() {
  const dispatch = useDispatch();
  const state = useSelector((r: RootState) => r.patrol);
  const pending = state.outbound.filter((p) => !p.firstResult).sort((a, b) => (a.deviceId === b.deviceId ? a.seq - b.seq : a.deviceId.localeCompare(b.deviceId)));
  const processed = state.outbound.filter((p) => p.firstResult);

  return (
    <View>
      <View className="card">
        <View className="card-title">待同步包<Text className="count">{pending.length} 包 · {pending.reduce((n, p) => n + p.entries.length, 0)} 条</Text></View>
        <Button className="primary" disabled={pending.length === 0} onClick={() => dispatch(syncAll())}>恢复联网：按设备序号顺序同步全部</Button>
        <Text className="hint">多设备同一次巡护的多个包、迟到包、缺包都在此一次性入库；包内某条失败，其他条目照常处理。</Text>
        {pending.map((p) => (
          <View className="packet" key={p.id}>
            <View className="packet-head"><Text className="packet-id">{p.deviceId} 包 #{p.seq}</Text><Text className="muted">{p.sealedAt} · {p.entries.length} 条 · 巡护 {p.patrolId}</Text></View>
            {p.clockOffsetMin !== 0 && <Text className="warn-hint">封包设备时间偏移 {p.clockOffsetMin} 分钟（判重与排序按业务键和序号，不按时钟）</Text>}
            <ReceiptRows entries={[]} fallback={p} />
          </View>
        ))}
      </View>

      <View className="card">
        <View className="card-title">已处理结果与重传<Text className="count">{processed.length} 包</Text></View>
        <Text className="hint">重传永远沿用第一次结果：旧包到得再晚，也不会把负责人退回过的结论顶掉。</Text>
        {processed.map((p) => {
          const r = p.firstResult!;
          return (
            <View className="packet" key={p.id}>
              <View className="packet-head">
                <Text className="packet-id">{p.deviceId} 包 #{p.seq}</Text>
                <Text className={`pill ${r.summary.rejected ? 'err' : r.summary.warning ? 'warn' : 'ok'}`}>{statusLabel(p.status)}</Text>
              </View>
              <Text className="muted">
                接收 {r.summary.accepted} · 待复核 {r.summary.warning} · 重复 {r.summary.duplicate} · 失败 {r.summary.rejected}
                {r.note ? ` · ${r.note}` : ''}
                {r.gap ? ` · 缺序号 ${r.gap.join('、')}` : ''}
              </Text>
              <ReceiptRows entries={r.entries} />
              <View className="packet-foot">
                <Text className="muted">已发送 {p.sentCount} 次{p.lastRetransmitAt ? ` · 最近重传 ${p.lastRetransmitAt}（沿用首次结果）` : ''}</Text>
                <Button size="mini" onClick={() => dispatch(retransmit(p.id))}>重传此包（幂等）</Button>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
