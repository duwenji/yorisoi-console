/** Settings of the spot tiles in one account (platform API-SPOT-TILES). */
export interface TilesConfig {
  name: 'dev' | 'prod';
  /** Optional: when set, the stack is pinned to this account. */
  account?: string;
  region: 'ap-northeast-1';
  /** When the weekly batch runs, in Japan time (S-5). Geofabrik's extract of the day is out by then. */
  schedule: { weekDay: string; hour: string };
  /** The Fargate task of the batch: Japan's extract is about 2GB, and the batch keeps the tiles in memory. */
  cpu: number;
  memoryMiB: number;
  diskGiB: number;
  /** Production keeps the tiles when the stack is deleted; development deletes them. */
  retainTiles: boolean;
  /** Where alarms go. */
  alarmEmail?: string;
}

export const tilesConfigs: Record<TilesConfig['name'], TilesConfig> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    schedule: { weekDay: 'WED', hour: '3' },
    cpu: 4096,
    memoryMiB: 16384,
    diskGiB: 40,
    retainTiles: false,
    alarmEmail: 'tofumiyoshi@gmail.com',
  },
  prod: {
    name: 'prod',
    region: 'ap-northeast-1',
    schedule: { weekDay: 'WED', hour: '3' },
    cpu: 4096,
    memoryMiB: 16384,
    diskGiB: 40,
    retainTiles: true,
  },
};
