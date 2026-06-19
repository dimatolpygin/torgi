// UAT этап 7: Telegram-уведомления, состояние сервера, алерты на торгах.
// Запуск: node src/scripts/check-telegram.js
// Нужен TELEGRAM_BOT_TOKEN в .env. Откройте своего бота в Telegram и отправьте /start.
//
// Сценарий проверки:
//   1. После /start приходит приветствие — чат подписан.
//   2. Приходит итог прогона: 1 успех + 1 ошибка с «подайте вручную».
//   3. Приходит алерт о возможной блокировке IP.
//   4. По команде /status приходит состояние сервера.
import { createNotifier } from '../notify.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!config.telegram.botToken) {
    logger.error('TELEGRAM_BOT_TOKEN не задан в .env — заполните и повторите');
    process.exit(1);
  }

  const startedAt = Date.now();
  const notifier = createNotifier({
    statusProvider: () => ({
      uptimeMs: Date.now() - startedAt,
      nextRun: 'вторник 23.06.2026 00:00',
      accounts: 2,
      dryRun: config.timing.dryRun,
    }),
  });
  notifier.launch();

  logger.info('Бот запущен. Откройте его в Telegram и отправьте /start (жду подписчика)…');
  let tries = 0;
  while ((await notifier.subscribers()).length === 0) {
    await sleep(2000);
    if (++tries % 5 === 0) logger.info('…всё ещё жду /start от вас в Telegram');
    if (tries > 150) {
      logger.error('Не дождался /start за 5 минут');
      process.exit(1);
    }
  }
  logger.info('✅ Подписчик зарегистрирован через /start');

  // 1. Итог ночной подачи: один успех, один провал.
  await notifier.notifyRunResult(
    [
      {
        tag: '1121298c017rb8',
        fio: 'Иванов Александр Эдуардович',
        success: true,
        booking: { market: 'Комаровский', date: '2026-06-23' },
      },
      { tag: 'muzh_acc', fio: 'Иванова Мария Петровна', success: false, reason: 'rejected' },
    ],
    { dryRun: false, date: '2026-06-23' },
  );
  logger.info('→ Отправлен итог прогона (1 успех + 1 ошибка). Проверьте сообщение в Telegram.');

  await sleep(1500);

  // 2. Алерт об ошибке на торгах (возможная блокировка).
  await notifier.alert(
    'Аккаунт Иванова М.П.: 5 ошибок подряд при подаче — возможна блокировка IP. Подайте вручную.',
  );
  logger.info('→ Отправлен алерт о возможной блокировке.');

  logger.info('Теперь отправьте боту /status — должно прийти состояние сервера.');
  logger.info('Когда проверите все сообщения — нажмите Ctrl+C. ✅ Этап 7 готов, если всё пришло.');

  // Держим процесс живым, чтобы можно было проверить /status.
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
