// UAT этап 13: отправка ОБРАЗЦОВ текстов в Telegram для проверки клиентом.
// Запуск (на сервере): docker compose run --rm app node src/scripts/send-samples.js
//
// НЕ запускает long polling (основной контейнер уже поллит) — только sendMessage,
// конфликта getUpdates нет. Не меняет состояние (last_run/подписчиков).
import { createNotifier } from '../notify.js';
import { runResultText, alertText, blockAlertBody, statusText } from '../messages.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fio1 = 'Иванов Александр Эдуардович';
const fio2 = 'Иванова Мария Петровна';

async function main() {
  const notifier = createNotifier({});
  const subs = await notifier.subscribers();
  if (subs.length === 0) {
    logger.error('Нет подписчиков — отправьте боту /start и повторите.');
    process.exit(1);
  }
  logger.info(`Подписчиков: ${subs.length}. Отправляю образцы…`);

  const samples = [
    '👀 Образцы сообщений бота (этап 13 — тексты). Это ПРИМЕРЫ для проверки формулировок, не реальные брони.',
    statusText({ uptimeMs: 3 * 3600_000 + 12 * 60_000, nextRun: 'воскресенье 21.06.2026 00:00', accounts: 2, dryRun: false, lastRun: { title: '2026-06-21 — успех (2/2)' } }),
    runResultText([
      { fio: fio1, success: true, booking: { market: 'Комаровский' } },
      { fio: fio2, success: true, booking: { market: 'Комаровский' } },
    ], { dryRun: false, date: '2026-06-21' }),
    runResultText([
      { fio: fio1, success: true, booking: { market: 'Комаровский' } },
      { fio: fio2, success: false, reason: 'rejected' },
    ], { dryRun: false, date: '2026-06-21' }),
    alertText(blockAlertBody({ account: fio2, streak: 5 })),
  ];

  for (const text of samples) {
    await notifier.notify(text);
    await sleep(900);
  }
  logger.info('✅ Образцы отправлены. Проверьте сообщения в Telegram.');

  await redis.quit().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  await redis.quit().catch(() => {});
  process.exit(1);
});
