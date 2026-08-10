/**
 * Seeds fake greater-Boston areas for local development of the area map UI.
 *
 * Safe to re-run: areas are upserted by `id`, so repeated runs converge rather
 * than duplicating. Run with `just seed-areas`.
 */
import { loadConfig } from '@/config.ts';
import { createRedisClient } from '@/infrastructure/redis/client.ts';
import { RedisAreaRepository } from '@/repository/area-repository/redis.repository.ts';
import type { Area } from '@/domain/types.ts';

const seedAreas: Area[] = [
  // AB — lives in Cambridge, works downtown, spread across the river.
  {
    id: 'ab-home',
    userId: 'AB',
    name: 'Home (Cambridge)',
    lat: 42.3744,
    lon: -71.1169,
    radius: 300,
  },
  {
    id: 'ab-work',
    userId: 'AB',
    name: 'Office (Kendall Sq)',
    lat: 42.3623,
    lon: -71.0864,
    radius: 250,
  },
  { id: 'ab-gym', userId: 'AB', name: 'Gym (Davis Sq)', lat: 42.3967, lon: -71.1218, radius: 150 },
  { id: 'ab-park', userId: 'AB', name: 'Boston Common', lat: 42.355, lon: -71.0656, radius: 500 },

  // CD — south of the city, commutes in along the Red Line.
  {
    id: 'cd-home',
    userId: 'CD',
    name: 'Home (Quincy Center)',
    lat: 42.2519,
    lon: -71.0022,
    radius: 400,
  },
  {
    id: 'cd-work',
    userId: 'CD',
    name: 'Office (Seaport)',
    lat: 42.3459,
    lon: -71.0448,
    radius: 350,
  },
  { id: 'cd-school', userId: 'CD', name: 'UMass Boston', lat: 42.3134, lon: -71.0384, radius: 600 },
  {
    id: 'cd-airport',
    userId: 'CD',
    name: 'Logan Airport',
    lat: 42.3656,
    lon: -71.0096,
    radius: 1200,
  },

  // EF — the wider metro ring, larger radii.
  {
    id: 'ef-home',
    userId: 'EF',
    name: 'Home (Newton Centre)',
    lat: 42.3298,
    lon: -71.1925,
    radius: 450,
  },
  {
    id: 'ef-work',
    userId: 'EF',
    name: 'Campus (Waltham)',
    lat: 42.3662,
    lon: -71.2593,
    radius: 800,
  },
  {
    id: 'ef-family',
    userId: 'EF',
    name: 'Family (Arlington)',
    lat: 42.4153,
    lon: -71.1564,
    radius: 300,
  },
  { id: 'ef-arena', userId: 'EF', name: 'TD Garden', lat: 42.3662, lon: -71.0621, radius: 200 },

  // GH — a single tight cluster, useful for checking overlap rendering.
  { id: 'gh-fenway', userId: 'GH', name: 'Fenway Park', lat: 42.3467, lon: -71.0972, radius: 250 },
  {
    id: 'gh-backbay',
    userId: 'GH',
    name: 'Back Bay Station',
    lat: 42.3474,
    lon: -71.0755,
    radius: 200,
  },
  {
    id: 'gh-brookline',
    userId: 'GH',
    name: 'Brookline Village',
    lat: 42.3318,
    lon: -71.1212,
    radius: 300,
  },
];

const config = loadConfig();
const redis = createRedisClient(config.redisUrl);
const areaRepo = new RedisAreaRepository(redis);

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
