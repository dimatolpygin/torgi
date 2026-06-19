// UAT этап 8: Хранилище и история.
// Запуск (в сети compose, как в реальном деплое):
//   docker compose up -d postgres redis
//   docker compose run --rm app node src/scripts/check-storage.js
//
// Проверяем:
//   A. Запись попытки в Postgres появляется и читается обратно (история).
//   B. Сессионная кука берётся из Redis при повторной подготовке — лишнего логина нет.
//   C. Флаг «сегодня подано» в Redis выставляется и читается.
import { ensureSchema, recordAttempt, getRecentAttempts, pool } from '../db.js';
import { redis, checkRedis } from '../redis.js';
import { checkPostgres } from '../db.js';
import { prepareAccount } from '../runner.js';
import { getAccounts } from '../accounts.js';
import { loadSession, saveSession, clearSession, markDone, isDone } from '../session.js';
import { logger } from '../logger.js';

async function main() {
  await checkPostgres();
  await checkRedis();
  await ensureSchema();

  let ok = true;

  // --- A. История в Postgres ---
  logger.info('--- A. Запись попытки в Postgres ---');
  const marker = `uat_${Date.now()}`;
  await recordAttempt({
    login: marker,
    fio: 'UAT Тестовый',
    targetDate: '2026-06-23',
    success: false,
    reason: 'rejected',
    dryRun: true,
    driftMs: 7,
    market: 'Комаровский',
    detail: { note: 'uat-check' },
  });
  const recent = await getRecentAttempts(5);
  const found = recent.find((r) => r.login === marker);
  logger.info(`Записей в выборке: ${recent.length}; наша запись найдена: ${found ? '✅' : '❌'}`);
  if (found) {
    logger.info(
      `  → ${found.login}: дата=${found.target_date?.toISOString?.().slice(0, 10) || found.target_date}, success=${found.success}, причина=${found.reason}, drift=${found.drift_ms}мс`,
    );
  }
  ok = ok && Boolean(found);

  // --- C. Флаг «сегодня подано» ---
  logger.info('--- C. Флаг «сегодня подано» в Redis ---');
  await markDone(marker, '2026-06-23');
  const done = await isDone(marker, '2026-06-23');
  logger.info(`isDone после markDone: ${done ? '✅' : '❌'}`);
  ok = ok && done;

  // --- B. Переиспользование сессии из Redis ---
  logger.info('--- B. Переиспользование сессии из Redis ---');
  const account = getAccounts()[0];
  if (!account) {
    logger.warn('ACCOUNTS пуст — полную проверку «логин один раз» пропускаю.');
    logger.warn('Делаю изолированную проверку round-trip кук через Redis…');
    await clearSession('uat_sess');
    await saveSession('uat_sess', { gorodid: 'test-cookie-123' });
    const loaded = await loadSession('uat_sess');
    const rt = loaded?.gorodid === 'test-cookie-123';
    logger.info(`Кука сохранена и прочитана из Redis: ${rt ? '✅' : '❌'}`);
    ok = ok && rt;
    await clearSession('uat_sess');
  } else {
    // Чистим сессию → первый prepare обязан реально залогиниться и сохранить куку.
    await clearSession(account.login);
    logger.info('Первая подготовка (ожидаю реальный логин)…');
    const first = await prepareAccount(account);
    await first.client?.close().catch(() => {});
    logger.info(`  первый раз: loggedIn=${first.loggedIn}, restored=${Boolean(first.restored)}`);

    logger.info('Вторая подготовка (ожидаю восстановление из Redis, без логина)…');
    const second = await prepareAccount(account);
    await second.client?.close().catch(() => {});
    logger.info(`  второй раз: loggedIn=${second.loggedIn}, restored=${Boolean(second.restored)}`);

    const reused = first.loggedIn && second.loggedIn && second.restored === true;
    logger.info(`Сессия переиспользована без повторного логина: ${reused ? '✅' : '❌'}`);
    ok = ok && reused;
  }

  logger.info(ok ? '✅ Этап 8: история пишется, сессия переживает перезапуск' : '❌ Этап 8: есть проблема');
  await pool.end().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  await pool.end().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(1);
});
