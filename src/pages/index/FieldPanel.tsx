import { Button, Input, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { addDraftObservation, addDraftSample, addDraftTrack, sealPacket } from '../../store';
import type { RootState } from '../../store';
import { materialLabel } from '../../patrol/ingest';
import type { PacketEntry } from '../../patrol/types';

const formSchema = z.object({
  note: z.string().min(2, '至少写两个字'),
  risk: z.enum(['low', 'medium', 'high']),
  species: z.string(),
  count: z.string(),
  code: z.string(),
  evidencePhoto: z.boolean(),
  withinCapability: z.boolean(),
  samplePhoto: z.boolean(),
  sampleLabeled: z.boolean()
});
type FormValues = z.infer<typeof formSchema>;

function entrySummary(entry: PacketEntry): string {
  switch (entry.kind) {
    case 'observation': return `${entry.risk === 'high' ? '高风险' : entry.risk === 'medium' ? '中风险' : '低风险'}观察：${entry.note}`;
    case 'track': return `轨迹点 ${entry.latitude.toFixed(4)}, ${entry.longitude.toFixed(4)}`;
    case 'sample': return `样本 ${entry.code} ${entry.species} × ${entry.count}`;
    case 'handoff': return `${entry.stage === 'inspect' ? '送检' : '交接'} ${entry.sampleCode} → ${entry.to}`;
    case 'supplement': return `补材料 ${entry.targetKey}：${entry.materials.map(materialLabel).join('、')}`;
  }
}

export function FieldPanel() {
  const dispatch = useDispatch();
  const state = useSelector((r: RootState) => r.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1', code: '', evidencePhoto: true, withinCapability: true, samplePhoto: true, sampleLabeled: true }
  });

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addDraftTrack({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      const jitter = () => Number((Math.random() * 0.004).toFixed(4));
      dispatch(addDraftTrack({ latitude: 30.582 + jitter(), longitude: 103.217 + jitter() }));
    }
  };

  const submit = (values: FormValues) => {
    let sampleCode: string | undefined;
    if (values.species.trim()) {
      sampleCode = values.code.trim() || `WD-0929-${String(Math.floor(Math.random() * 80) + 10)}`;
      dispatch(addDraftSample({ code: sampleCode, species: values.species, count: Number(values.count) || 1, photo: values.samplePhoto, labeled: values.sampleLabeled }));
    }
    dispatch(addDraftObservation({
      note: values.note, risk: values.risk,
      evidencePhoto: values.evidencePhoto, withinCapability: values.withinCapability,
      latitude: 30.586, longitude: 103.221, sampleCode
    }));
    reset();
  };

  const device = state.devices[state.selfDeviceId];
  const legacy = device.appVersion === 1;

  return (
    <View>
      <View className="card">
        <View className="card-title">现场记录<Text className="count">时钟偏移 {state.clockOffsetMin} 分钟（序号不受影响）</Text></View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note')} />
          <View className="two">
            <Input className="input" placeholder="物种/样本名称（可空）" {...register('species')} />
            <View className="two">
              <Input className="input" placeholder="样本编号（可空自动）" {...register('code')} />
              <Input className="input" type="number" placeholder="数量" {...register('count')} />
            </View>
          </View>
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>
          </View>
          <View className="checks">
            <label><input type="checkbox" {...register('evidencePhoto')} /> 已拍现场照片</label>
            <label><input type="checkbox" {...register('withinCapability')} /> 在本队能力范围内</label>
            <label><input type="checkbox" {...register('samplePhoto')} /> 已拍样本照片</label>
            <label><input type="checkbox" {...register('sampleLabeled')} /> 样本编号标签齐全</label>
          </View>
          <Button className="primary" formType="submit">保存进草稿包</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
        {legacy && <Text className="hint warn-hint">当前为旧版 App：新记录也只会保存采集人与时间，升级后旧记录仍可查看和交接。</Text>}
        <Text className="hint">提示：取消勾选“已拍现场照片”或“能力范围内”，可模拟负责人将要求补材料的观察。</Text>
      </View>

      <View className="card">
        <View className="card-title">草稿包（未封包）<Text className="count">{state.draft.length} 条 · 封包后序号 {device.lastSeq + 1}</Text></View>
        {state.draft.length === 0 && <Text className="hint">草稿为空，封包后将进入待同步队列。</Text>}
        {state.draft.map((entry) => (
          <View className="row" key={entry.id}>
            <View><Text className="row-title">#{entry.ordinal} {entrySummary(entry)}</Text><Text className="muted">{entry.at} · {entry.collector}{(entry.kind === 'observation' || entry.kind === 'sample') && entry.legacy ? ' · 旧机记录' : ''}</Text></View>
          </View>
        ))}
        <Button className="secondary" disabled={state.draft.length === 0} onClick={() => dispatch(sealPacket())}>
          封离线包（巡护 {state.patrolId}，设备连续序号 {device.lastSeq + 1}）
        </Button>
      </View>
    </View>
  );
}
