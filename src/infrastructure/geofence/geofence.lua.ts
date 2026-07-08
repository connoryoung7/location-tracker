import type { RedisClient } from 'bun';
import { createHash } from 'node:crypto';

/**
 * KEYS[1] = geo:areas:{userId}
 * KEYS[2] = area:meta:{userId}
 * KEYS[3] = area:maxradius:{userId}
 * KEYS[4] = geofence:inside:{userId}
 * KEYS[5] = geofence:pending-exit:{userId}
 *
 * ARGV[1] = userId
 * ARGV[2] = lon
 * ARGV[3] = lat
 * ARGV[4] = tst
 * ARGV[5] = thresholdSeconds
 *
 * Returns a flat array: { type, areaId, areaName, lat, lon, tst, ... }
 * where type is "entered" or "exited".
 */
export const GEOFENCE_LUA_SCRIPT = `
local geoAreasKey = KEYS[1]
local areaMetaKey = KEYS[2]
local maxRadiusKey = KEYS[3]
local insideKey = KEYS[4]
local pendingExitKey = KEYS[5]

local userId = ARGV[1]
local lon = tonumber(ARGV[2])
local lat = tonumber(ARGV[3])
local tst = tonumber(ARGV[4])
local thresholdSeconds = tonumber(ARGV[5])

local events = {}

local maxRadius = redis.call('GET', maxRadiusKey)
if not maxRadius then
  return events
end

local candidates = redis.call('GEOSEARCH', geoAreasKey, 'FROMLONLAT', tostring(lon), tostring(lat), 'BYRADIUS', maxRadius, 'm', 'WITHDIST')

local nowInside = {}
for _, candidate in ipairs(candidates) do
  local areaId = candidate[1]
  local distance = tonumber(candidate[2])
  local metaRaw = redis.call('HGET', areaMetaKey, areaId)
  if metaRaw then
    local meta = cjson.decode(metaRaw)
    if distance <= meta.radius then
      nowInside[areaId] = meta
    end
  end
end

local prev = redis.call('SMEMBERS', insideKey)
local wasInside = {}
for _, areaId in ipairs(prev) do
  wasInside[areaId] = true
end

for areaId, meta in pairs(nowInside) do
  if not wasInside[areaId] then
    redis.call('SADD', insideKey, areaId)
    redis.call('HDEL', pendingExitKey, areaId)
    table.insert(events, { 'entered', areaId, meta.name, tostring(lat), tostring(lon), tostring(tst) })
  end
end

for _, areaId in ipairs(prev) do
  if nowInside[areaId] then
    redis.call('HDEL', pendingExitKey, areaId)
  else
    local pendingSince = redis.call('HGET', pendingExitKey, areaId)
    if not pendingSince then
      redis.call('HSET', pendingExitKey, areaId, tostring(tst))
    elseif (tst - tonumber(pendingSince)) >= thresholdSeconds then
      redis.call('SREM', insideKey, areaId)
      redis.call('HDEL', pendingExitKey, areaId)
      local metaRaw = redis.call('HGET', areaMetaKey, areaId)
      local areaName = ''
      if metaRaw then
        areaName = cjson.decode(metaRaw).name
      end
      table.insert(events, { 'exited', areaId, areaName, tostring(lat), tostring(lon), tostring(tst) })
    end
  end
end

return events
`;

const scriptSha = createHash('sha1').update(GEOFENCE_LUA_SCRIPT).digest('hex');

export async function evalGeofenceScript(
  redis: RedisClient,
  keys: string[],
  args: string[],
): Promise<unknown> {
  try {
    return await redis.send('EVALSHA', [scriptSha, String(keys.length), ...keys, ...args]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      return await redis.send('EVAL', [GEOFENCE_LUA_SCRIPT, String(keys.length), ...keys, ...args]);
    }
    throw err;
  }
}
