import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

// Без обработчика ioredis сыплет необработанными ошибками в лог при недоступном
// Redis (локальный UAT). Вызывающий код сам решает, фатально это или фолбэк.
redis.on('error', (e) => logger.debug(`Redis: ${e.message}`));

// Проверка подключения к Redis.
export async function checkRedis() {
  if (redis.status !== 'ready' && redis.status !== 'connecting') {
    await redis.connect();
  }
  const pong = await redis.ping();
  logger.info(`✅ Redis подключён: ответ ${pong}`);
  return pong;
}

export default redis;
