/**
 * Seeds Greater Boston areas for local development of the area map UI.
 *
 * Safe to re-run: areas are upserted by `id`, so repeated runs converge rather
 * than duplicating. Run with `just seed-areas`.
 */
import { loadConfig } from '@/config.ts';
import { createRedisClient } from '@/infrastructure/redis/client.ts';
import { RedisAreaRepository } from '@/repository/area-repository/redis.repository.ts';
import type { Area } from '@/domain/types.ts';

const seedAreas: Area[] = [
  // BO: central Boston landmarks and commute hubs.
  {
    id: 'bo-boston-common',
    userId: 'BO',
    name: 'Boston Common',
    lat: 42.355,
    lon: -71.0656,
    radius: 500,
  },
  {
    id: 'bo-south-station',
    userId: 'BO',
    name: 'South Station',
    lat: 42.3523,
    lon: -71.0552,
    radius: 250,
  },
  {
    id: 'bo-td-garden',
    userId: 'BO',
    name: 'TD Garden / North Station',
    lat: 42.3662,
    lon: -71.0621,
    radius: 250,
  },
  {
    id: 'bo-seaport',
    userId: 'BO',
    name: 'Seaport District',
    lat: 42.3519,
    lon: -71.0422,
    radius: 650,
  },
  {
    id: 'bo-logan-airport',
    userId: 'BO',
    name: 'Logan Airport',
    lat: 42.3656,
    lon: -71.0096,
    radius: 1200,
  },

  // CA: Cambridge and Somerville squares with intentionally nearby areas.
  {
    id: 'ca-harvard-square',
    userId: 'CA',
    name: 'Harvard Square',
    lat: 42.3736,
    lon: -71.119,
    radius: 350,
  },
  {
    id: 'ca-central-square',
    userId: 'CA',
    name: 'Central Square',
    lat: 42.3655,
    lon: -71.1036,
    radius: 300,
  },
  {
    id: 'ca-kendall-square',
    userId: 'CA',
    name: 'Kendall Square / MIT',
    lat: 42.3623,
    lon: -71.0864,
    radius: 300,
  },
  {
    id: 'ca-davis-square',
    userId: 'CA',
    name: 'Davis Square',
    lat: 42.3967,
    lon: -71.1218,
    radius: 250,
  },
  {
    id: 'ca-assembly-row',
    userId: 'CA',
    name: 'Assembly Row',
    lat: 42.3926,
    lon: -71.0785,
    radius: 500,
  },

  // BW: Fenway, Brookline, Jamaica Plain, and the Longwood medical cluster.
  {
    id: 'bw-fenway-park',
    userId: 'BW',
    name: 'Fenway Park',
    lat: 42.3467,
    lon: -71.0972,
    radius: 250,
  },
  {
    id: 'bw-longwood',
    userId: 'BW',
    name: 'Longwood Medical Area',
    lat: 42.3364,
    lon: -71.1056,
    radius: 600,
  },
  {
    id: 'bw-brookline-village',
    userId: 'BW',
    name: 'Brookline Village',
    lat: 42.3318,
    lon: -71.1212,
    radius: 300,
  },
  {
    id: 'bw-coolidge-corner',
    userId: 'BW',
    name: 'Coolidge Corner',
    lat: 42.3429,
    lon: -71.1229,
    radius: 300,
  },
  {
    id: 'bw-jamaica-pond',
    userId: 'BW',
    name: 'Jamaica Pond',
    lat: 42.3161,
    lon: -71.1209,
    radius: 650,
  },

  // WE: western suburbs and Watertown.
  {
    id: 'we-newton-centre',
    userId: 'WE',
    name: 'Newton Centre',
    lat: 42.3298,
    lon: -71.1925,
    radius: 450,
  },
  {
    id: 'we-waltham-common',
    userId: 'WE',
    name: 'Waltham Common',
    lat: 42.3765,
    lon: -71.2356,
    radius: 450,
  },
  {
    id: 'we-arsenal-yards',
    userId: 'WE',
    name: 'Arsenal Yards',
    lat: 42.3636,
    lon: -71.1573,
    radius: 450,
  },
  {
    id: 'we-alewife',
    userId: 'WE',
    name: 'Alewife Station',
    lat: 42.3954,
    lon: -71.1425,
    radius: 350,
  },

  // SO: south-of-Boston fixtures with larger outdoor areas.
  {
    id: 'so-quincy-center',
    userId: 'SO',
    name: 'Quincy Center',
    lat: 42.2519,
    lon: -71.0022,
    radius: 450,
  },
  {
    id: 'so-umass-boston',
    userId: 'SO',
    name: 'UMass Boston',
    lat: 42.3134,
    lon: -71.0384,
    radius: 700,
  },
  {
    id: 'so-blue-hills',
    userId: 'SO',
    name: 'Blue Hills Reservation',
    lat: 42.2127,
    lon: -71.0865,
    radius: 1800,
  },

  // NO: north-of-Boston inner suburbs.
  {
    id: 'no-malden-center',
    userId: 'NO',
    name: 'Malden Center',
    lat: 42.4266,
    lon: -71.0746,
    radius: 400,
  },
  {
    id: 'no-medford-square',
    userId: 'NO',
    name: 'Medford Square',
    lat: 42.4184,
    lon: -71.1062,
    radius: 450,
  },
  {
    id: 'no-wellington',
    userId: 'NO',
    name: 'Wellington Station',
    lat: 42.4024,
    lon: -71.0771,
    radius: 350,
  },
];

const config = loadConfig();
const redis = createRedisClient(config.redisUrl);
const areaRepo = new RedisAreaRepository(redis);

// The client fails commands fast rather than queueing them while disconnected,
// which suits the long-running servers but means a short script has to wait for
// the connection before issuing its first command.
await redis.connect();

for (const area of seedAreas) {
  await areaRepo.addArea(area);
}

const stored = await areaRepo.listAllAreas();
const byUser = new Map<string, number>();
for (const area of stored) {
  byUser.set(area.userId, (byUser.get(area.userId) ?? 0) + 1);
}

console.log(`Seeded ${seedAreas.length} areas into ${config.redisUrl}`);
console.log(`Redis now holds ${stored.length} areas across ${byUser.size} users:`);
for (const [userId, count] of [...byUser].sort()) {
  console.log(`  ${userId}: ${count}`);
}

process.exit(0);
