import { DemoRig } from './demoRig';

/** 巡护稳定标识由设备端在巡护开始时生成，服务端沿用同一标识归包。 */
let rig = new DemoRig();

export const PATROL_ID = rig.patrolId;

export function getRig(): DemoRig {
  return rig;
}

export function resetRig(): DemoRig {
  rig = new DemoRig();
  return rig;
}
