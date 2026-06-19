import { config } from './config.js';
import { logger } from './logger.js';
import { checkPostgres, pool } from './db.js';
import { checkRedis, redis } from './redis.js';

async function main() {
  logger.info('🚀 bron-bot запускается…');
  logger.info(`Рынок: id=${config.site.rinokId}, ассортимент: [${config.site.assortIds.join(', ')}], таймзона: ${config.timing.timezone}, dry-run: ${config.timing.dryRun}`);

  // Этап 0: проверяем, что инфраструктура поднята и доступна.
  try {
    await checkPostgres();
    await checkRedis();
  } catch (err) {
    logger.error(`❌ Ошибка подключения к инфраструктуре: ${err.message}`);
    process.exit(1);
  }

  logger.info('✅ Каркас жив, инфраструктура на связи. Ожидание следующих этапов.');

  // Держим процесс живым (на следующих этапах здесь будет планировщик).
  const shutdown = async (signal) => {
    logger.info(`Получен ${signal}, завершаюсь…`);
    await pool.end().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // heartbeat, чтобы было видно, что сервис жив
  setInterval(() => {
    logger.debug('heartbeat: жив');
  }, 60_000);
}

main().catch((err) => {
  logger.error(`❌ Фатальная ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
