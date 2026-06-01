import { Redis } from '@upstash/redis/cloudflare';

let _redis: Redis | null = null;

/** Lazily-initialised Redis client — only connects when first called. */
export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token || url.startsWith('your_')) {
      throw new Error(
        'Missing Upstash Redis credentials. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env.local.',
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

/** Rooms expire after 4 hours of inactivity. */
export const ROOM_TTL_SECONDS = 60 * 60 * 4;
