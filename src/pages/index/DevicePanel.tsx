import { Button, Text, View } from '@tarojs/components';
import { useDispatch, useSelector } from 'react-redux';
import { resetDemo, switchDevice, upgradeDevice } from '../../store';
import type { RootState } from '../../store';

export function DevicePanel() {
  const dispatch = useDispatch();
  const state = useSelector((r: RootState) => r.patrol);

  return (
    <View>
      <View className="card">
        <View className="card-title">设备与换人</View>
        <Text className="hint">设备换人后，旧记录只认采集人和时间；换机查看不丢数据，旧机升级 App 后仍能查看旧记录并继续交接。</Text>
        {Object.values(state.devices).map((d) => {
          const sampleCount = Object.values(state.samples).filter((s) => s.deviceId === d.deviceId).length;
          const legacySegments = state.segments.filter((s) => s.deviceId === d.deviceId && s.legacy).length;
          return (
            <View className="row device-row" key={d.deviceId}>
              <View className="row-main">
                <Text className="row-title">{d.deviceId} · {d.user}{d.appVersion === 1 ? ' · 旧版 App v1' : ' · 新版 App v2'}</Text>
                <Text className="muted">已封包到序号 #{d.lastSeq} · 条目序号到 #{d.nextOrdinal - 1} · 服务端水位 #{state.seqWatermark[d.deviceId] ?? 0} · 样本 {sampleCount}{legacySegments ? ` · 旧机记录 ${legacySegments}` : ''}</Text>
              </View>
              <View className="btn-stack">
                <Button size="mini" disabled={d.deviceId === state.selfDeviceId} onClick={() => dispatch(switchDevice(d.deviceId))}>
                  {d.deviceId === state.selfDeviceId ? '当前设备' : '换人使用'}
                </Button>
                {d.appVersion === 1 && <Button size="mini" className="ok-btn" onClick={() => dispatch(upgradeDevice(d.deviceId))}>升级 App（保留旧记录）</Button>}
              </View>
            </View>
          );
        })}
      </View>

      <View className="card">
        <View className="card-title">场景演示指引</View>
        <Text className="hint demo-line">1. 同步页：点“恢复联网”，观察 D-01#4 中未知样本交接失败但同包其余条目照常入库。</Text>
        <Text className="hint demo-line">2. 同步页：已处理包点“重传”，逐条结果与首次完全一致（含失败原因/待补材料）。</Text>
        <Text className="hint demo-line">3. 复核页：退回样本 WD-0929-07，台账里交接/送检段变为已作废、采集段保留；补材料→回现场页封包→同步→可重新交接。</Text>
        <Text className="hint demo-line">4. 顶部把时钟拨到 -30 分钟后记录轨迹，台账提示时间回拨但按序号排序。</Text>
        <Text className="hint demo-line">5. 设备页切到 D-03 看旧机记录（仅采集人/时间），升级后旧记录还在且可继续交接。</Text>
        <Button className="secondary danger" onClick={() => dispatch(resetDemo())}>重置演示数据</Button>
      </View>
    </View>
  );
}
