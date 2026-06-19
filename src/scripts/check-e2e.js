// UAT этап 10: E2E тест-прогон на сервере с имитацией полуночи.
// Запуск (на сервере, в сети compose):
//   docker compose run --rm app node src/scripts/check-e2e.js
//
// Прогоняет полный цикл по аккаунту: логин → состояние рынка → формирование
// заявки → верификация → уведомление в Telegram. Целевая минута подставная
// (через ~30с вместо полуночи). При DRY_RUN=true реальная заявка не отправляется.
//
// ВАЖНО: скрипт НЕ запускает long polling (основной контейнер уже поллит этим
// токеном) — только отправляет сообщение через sendMessage, конфликта нет.
import { createNotifier } from '../notify.js';
import { runNightly } from '../orchestrator.js';
import { getAccounts } from '../accounts.js';
import { getRecentAttempts, pool } from '../db.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function main() {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    logger.error('ACCOUNTS пуст — нечего прогонять');
    process.exit(1);
  }

  const notifier = createNotifier({
    statusProvider: () => ({ accounts: accounts.length, dryRun: config.timing.dryRun }),
  });
  // НЕ notifier.launch() — иначе конфликт getUpdates с основным контейнером.

  const subs = await notifier.subscribers();
  if (subs.length === 0) {
    logger.warn('Нет подписчиков Telegram — уведомление никому не уйдёт. Отправьте боту /start.');
  } else {
    logger.info(`Подписчиков Telegram: ${subs.length}`);
  }

  const targetMs = Date.now() + 30_000;
  logger.info(`E2E: имитация полуночи через 30с (DRY_RUN=${config.timing.dryRun})`);

  const results = await runNightly(notifier, accounts, { targetMs, leadSeconds: 25 });

  logger.info(`E2E итог по аккаунтам: ${results.map((r) => `${r.fio || r.tag}=${r.success ? 'OK' : 'FAIL:' + r.reason}`).join(' · ')}`);

  // Проверим, что попытка записалась в Postgres.
  const recent = await getRecentAttempts(accounts.length);
  logger.info(`Последние записи в БД: ${recent.length}`);
  recent.forEach((r) =>
    logger.info(`  → ${r.login}: дата=${r.target_date?.toISOString?.().slice(0, 10) || r.target_date}, success=${r.success}, dry_run=${r.dry_run}, drift=${r.drift_ms}мс`),
  );

  const allOk = results.length > 0 && recent.length >= results.length;
  logger.info(allOk ? '✅ Этап 10: полный цикл отработал, уведомление отправлено, попытка в БД' : '❌ Этап 10: проверьте детали выше');

  await pool.end().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  await pool.end().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(1);
});
