import { config } from './config.js';
import { logger } from './logger.js';
import { checkPostgres, ensureSchema, pool } from './db.js';
import { checkRedis, redis } from './redis.js';
import { getAccounts } from './accounts.js';
import { createNotifier } from './notify.js';
import { startScheduler } from './orchestrator.js';
import { nextRegistrationMidnight } from './scheduler.js';
import { startedNotice, stoppedNotice } from './messages.js';

const VERSION = '0.2.0';

async function main() {
  const startedAt = Date.now();
  logger.info(`🚀 bron-bot v${VERSION} запускается…`);
  logger.info(
    `Рынок: id=${config.site.rinokId}, ассортимент: [${config.site.assortIds.join(', ')}], таймзона: ${config.timing.timezone}, dry-run: ${config.timing.dryRun}`,
  );

  // Этап 0: проверяем, что инфраструктура поднята и доступна.
  try {
    await checkPostgres();
    await ensureSchema();
    await checkRedis();
  } catch (err) {
    logger.error(`❌ Ошибка подключения к инфраструктуре: ${err.message}`);
    process.exit(1);
  }

  const accounts = getAccounts();
  const nextRunStr = () =>
    nextRegistrationMidnight().setLocale('ru').toFormat('cccc dd.MM.yyyy HH:mm');

  // Этап 7: Telegram-бот — уведомления, состояние сервера, алерты.
  const notifier = createNotifier({
    statusProvider: () => ({
      uptimeMs: Date.now() - startedAt,
      nextRun: nextRunStr(),
      accounts: accounts.length,
      dryRun: config.timing.dryRun,
    }),
  });
  notifier.launch();
  await notifier
    .notify(
      startedNotice({
        nextRun: nextRunStr(),
        dryRun: config.timing.dryRun,
        accounts: accounts.length,
      }),
    )
    .catch(() => {});

  logger.info('✅ Каркас жив, Telegram подключён. Планировщик ночной подачи активен.');

  const shutdown = async (signal) => {
    logger.info(`Получен ${signal}, завершаюсь…`);
    await notifier.notify(stoppedNotice()).catch(() => {});
    notifier.stop(signal);
    await pool.end().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Вечный цикл ночных прогонов.
  await startScheduler(notifier);
}

main().catch((err) => {
  logger.error(`❌ Фатальная ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
