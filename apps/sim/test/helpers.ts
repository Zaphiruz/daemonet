import type { SubnetDef } from '@daemonet/rules';

/** 32 x 32 open test subnet: one wall segment, host at (4.5, 4.5), no spawn regions. */
export const TEST_SUBNET: SubnetDef = {
  id: 'test',
  width: 32,
  height: 32,
  walls: [{ x: 16, y: 1, w: 1, h: 20 }],
  host: { x: 4.5, y: 4.5 },
  spawn: { x: 5.5, y: 4.5 },
  regions: [],
};
