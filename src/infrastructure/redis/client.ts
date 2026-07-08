import { RedisClient } from 'bun';

export function createRedisClient(url: string): RedisClient {
  return new RedisClient(url);
}
