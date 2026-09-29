import { Button, Text, View } from '@tarojs/components';
import { useDispatch, useSelector } from 'react-redux';
import { setClockOffset, switchDevice, upgradeDevice } from '../../store';
import type { RootState } from '../../store';
import { pendingPackets } from '../../patrol/selectors';

export function StatusBar({ tab, setTab }: { tab: string; setTab: (t: string) => void }) {
  const dispatch = useDispatch();
  const state = useSelector((r: RootState) => r.patrol);
  const pending = pendingPackets(state);
  const device = state.devices[state.selfDeviceId];
  const tabs = [
    { key: 'field', label: '现场' },
    { key: 'packets', label: `同步${pending.length ? ` · ${pending.length}` : ''}` },
    { key: 'review', label: '复核' },
    { key: 'records', label: '台账' },
    { key: 'device', label: '设备' }
  ];
  return (
    <View className="hero">
      <Text className="eyebrow">FIELD PATROL / 稳定巡护 {state.patrolId}</Text>
      <View className="hero-row">
        <View>
          <Text className="title">离线巡护包</Text>
          <Text className="sub">设备 {state.selfDeviceId} · {state.currentUser} · App v{device.appVersion}
            {device.appVersion === 1 && <Text className="legacy-tag"> 旧版（仅采集人/时间）</Text>}
          </Text>
        </View>
        <View className="clock-box">
          <Text className="clock-label">设备时钟偏移（分钟）</Text>
          <View className="clock-actions">
            <Button size="mini" onClick={() => dispatch(setClockOffset(state.clockOffsetMin - 5))}>-5</Button>
            <Text className="clock-val">{state.clockOffsetMin}</Text>
            <Button size="mini" onClick={() => dispatch(setClockOffset(state.clockOffsetMin + 5))}>+5</Button>
          </View>
        </View>
      </View>
      <View className="metrics">
        <View><Text>设备包序号</Text><Text className="metric">{device.lastSeq}</Text></View>
        <View><Text>待同步包</Text><Text className={pending.length ? 'metric warn' : 'metric'}>{pending.length}</Text></View>
        <View><Text>样本</Text><Text className="metric">{Object.keys(state.samples).length}</Text></View>
      </View>
      <View className="switcher">
        {Object.values(state.devices).map((d) => (
          <Button key={d.deviceId} size="mini"
            className={d.deviceId === state.selfDeviceId ? 'tab active' : 'tab'}
            onClick={() => dispatch(switchDevice(d.deviceId))}>
            {d.deviceId} {d.user}
          </Button>
        ))}
        {device.appVersion === 1 && <Button size="mini" className="tab upgrade" onClick={() => dispatch(upgradeDevice(device.deviceId))}>升级 {device.deviceId}</Button>}
      </View>
      <View className="tabs">
        {tabs.map((t) => <Button key={t.key} size="mini" className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>{t.label}</Button>)}
      </View>
    </View>
  );
}
