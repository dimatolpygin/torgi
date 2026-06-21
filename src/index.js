import { config } from './config.js';
import { logger } from './logger.js';
import { checkPostgres, ensureSchema, pool } from './db.js';
import { checkRedis, redis } from './redis.js';
import { getAccounts } from './accounts.js';
import { createNotifier } from './notify.js';
import { startScheduler } from './orchestrator.js';
import { nextRegistrationMidnight } from './scheduler.js';
import { startHealthPing } from './health.js';
import { startedNotice, stoppedNotice } from './messages.js';

const VERSION = '0.2.0';

// Глобальная страховка: не падать молча от случайного rejection/исключения.
// Логируем и продолжаем — основной цикл подачи и так обёрнут в try/catch,
// терять рабочую ночь из-за стрэй-ошибки нельзя.
process.on('unhandledRejection', (reason) => {
  logger.error(`Необработанный rejection: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Необработанное исключение: ${err?.stack || err?.message || err}`);
});

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
  // Запуск/остановка — только разработчику (роль dev).
  await notifier
    .notifyDev(
      startedNotice({
        nextRun: nextRunStr(),
        dryRun: config.timing.dryRun,
        accounts: accounts.length,
      }),
    )
    .catch(() => {});

  // Этап 16: внешний dead-man's switch (пинг healthchecks.io).
  const stopHealth = startHealthPing();

  logger.info('✅ Каркас жив, Telegram подключён. Планировщик ночной подачи активен.');

  const shutdown = async (signal) => {
    logger.info(`Получен ${signal}, завершаюсь…`);
    stopHealth();
    await notifier.notifyDev(stoppedNotice()).catch(() => {});
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
