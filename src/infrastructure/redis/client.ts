export function createRedisClient(): typeof Bun.redis {
  return Bun.redis;
}
