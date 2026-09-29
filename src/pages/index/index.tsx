import { useState } from 'react';
import { View } from '@tarojs/components';
import './index.scss';
import { StatusBar } from './StatusBar';
import { FieldPanel } from './FieldPanel';
import { SyncPanel } from './SyncPanel';
import { ReviewPanel } from './ReviewPanel';
import { RecordsPanel } from './RecordsPanel';
import { DevicePanel } from './DevicePanel';

export default function Index() {
  const [tab, setTab] = useState('field');
  return (
    <View className="page">
      <StatusBar tab={tab} setTab={setTab} />
      {tab === 'field' && <FieldPanel />}
      {tab === 'packets' && <SyncPanel />}
      {tab === 'review' && <ReviewPanel />}
      {tab === 'records' && <RecordsPanel />}
      {tab === 'device' && <DevicePanel />}
    </View>
  );
}
