import { DateTime } from 'luxon';
import { config } from './config.js';
import { logger } from './logger.js';
import { getAccounts } from './accounts.js';
import { prepareAll, attemptForAccount, closeAll, buildDateStr, warmConnection } from './runner.js';
import { recordAttempt } from './db.js';
import { nextRegistrationMidnight, waitUntil, fireAt, retryUntil } from './scheduler.js';
import { blockAlertBody, runFailureBody, preflightNotice, timingNotice } from './messages.js';

// Подача по одному аккаунту: первая попытка в 00:00, при неуспехе — безопасная
// долбёжка (этап 5). Серия сетевых ошибок (возможная блокировка IP) → алерт.
// Алерт шлём один раз за ночь, чтобы не спамить.
async function runForContext(ctx, notifier) {
  const withFio = (r) => ({ ...r, fio: ctx.fio });

  const first = await attemptForAccount(ctx, 1).catch((e) => ({
    tag: ctx.tag,
    success: false,
    reason: 'error',
    error: e,
  }));
  if (first.success) return withFio(first);

  let alerted = false;
  const retried = await retryUntil((n) => attemptForAccount(ctx, n), {
    onPossibleBlock: (streak) => {
      if (alerted) return;
      alerted = true;
      notifier
        .alert(blockAlertBody({ account: ctx.fio || ctx.tag, streak }))
        .catch(() => {});
    },
  });
  return withFio(retried);
}

// Одна ночь: прогрев аккаунтов за leadSeconds → выстрел в 00:00 параллельно по
// всем аккаунтам (каждый со своей долбёжкой) → уведомление об итоге в Telegram.
export async function runNightly(
  notifier,
  accounts = getAccounts(),
  { tz = config.timing.timezone, leadSeconds = config.timing.prepareLeadSeconds, targetMs: targetOverride } = {},
) {
  // targetOverride — подставная целевая минута для E2E-прогона (этап 10).
  const target = targetOverride
    ? DateTime.fromMillis(targetOverride).setZone(tz)
    : nextRegistrationMidnight(tz);
  const targetMs = targetOverride || target.toMillis();

  // Этап 12: дата брони предвычисляется (в 00:00 открывается дата на bookingLeadDays
  // вперёд). Прокидываем её в прогрев, чтобы в полночь не читать календарь.
  const booking = target.plus({ days: config.timing.bookingLeadDays });
  const predicted = {
    day: booking.day,
    month: booking.month,
    year: booking.year,
    dateStr: buildDateStr(booking.day, booking.month, booking.year),
  };

  logger.info(
    `${targetOverride ? 'E2E-прогон' : 'Следующая подача'}: ${target.setLocale('ru').toFormat('cccc dd.MM.yyyy HH:mm:ss')} (${tz}), ` +
      `дата брони (прогноз): ${predicted.dateStr}, аккаунтов: ${accounts.length}`,
  );

  // Прогрев за leadSeconds до полуночи (изолированные сессии): логин, поля формы,
  // тип места — всё заранее, чтобы в 00:00 ушёл только create_zajav.
  await waitUntil(targetMs - leadSeconds * 1000);
  logger.info(`⏰ Прогрев за ${leadSeconds}с до полуночи…`);
  const contexts = await prepareAll(accounts, { predicted });
  // targetMs нужен быстрому пути для замера «от 00:00 до подачи».
  contexts.forEach((ctx) => {
    ctx.targetMs = targetMs;
  });

  // Pre-flight (этап 16): позитивное подтверждение разработчику, что бот жив и
  // прогрелся — ровно в единственный важный момент (за leadSeconds до 00:00).
  // Отсутствие этого сообщения = бот не дошёл до прогрева.
  if (config.health.preflight) {
    const ready = contexts.filter((c) => c.loggedIn).length;
    await notifier
      .notifyDev(
        preflightNotice({
          nextRun: target.setLocale('ru').toFormat('cccc dd.MM.yyyy HH:mm'),
          ready,
          total: contexts.length,
          dryRun: config.timing.dryRun,
        }),
      )
      .catch(() => {});
  }

  // Тёплое соединение за warmAheadMs до полуночи (этап 14): «оживляем» сокет,
  // чтобы create_zajav в 00:00 ушёл по горячему TLS за 1 RTT. Завершаем заранее,
  // чтобы запрос не висел на единственном соединении в момент выстрела.
  const warmAheadMs = config.timing.warmAheadMs;
  if (warmAheadMs > 0 && targetMs - Date.now() > warmAheadMs) {
    await waitUntil(targetMs - warmAheadMs);
    logger.info(`🔥 Прогрев соединения за ${warmAheadMs}мс до полуночи…`);
    await Promise.all(contexts.map((ctx) => warmConnection(ctx)));
  }

  // Точный выстрел в 00:00:00.000, параллельно по всем аккаунтам.
  const { drift, result: results } = await fireAt(targetMs, () =>
    Promise.all(contexts.map((ctx) => runForContext(ctx, notifier))),
  );

  // Дата подачи: предвычисленная (+7) всегда известна, даже если все аккаунты упали.
  const date = results.find((x) => x.date)?.date || predicted.dateStr;

  // История: пишем каждую попытку в Postgres (этап 8). Сбой записи не должен
  // ронять прогон — логируем и идём дальше.
  await Promise.all(
    results.map((r) =>
      recordAttempt({
        login: r.tag,
        fio: r.fio,
        targetDate: r.date || date || null,
        success: r.success,
        reason: r.reason || null,
        dryRun: config.timing.dryRun,
        driftMs: drift,
        market: r.booking?.market || null,
        detail: { reason: r.reason, dryRun: r.dryRun, alreadyDone: r.alreadyDone, response: r.response },
      }).catch((e) => logger.warn(`Не записал попытку ${r.tag} в БД: ${e.message}`)),
    ),
  );

  await notifier.notifyRunResult(results, { date });
  // Тайминг подачи — отдельным сообщением только разработчику (точность выстрела +
  // «от 00:00 до подачи» по каждому аккаунту).
  await notifier
    .notifyDev(timingNotice({ drift, results, dryRun: config.timing.dryRun }))
    .catch(() => {});
  await closeAll(contexts);
  return results;
}

// Вечный цикл: каждую ночь по расписанию (понедельники пропускаются планировщиком).
export async function startScheduler(notifier) {
  for (;;) {
    const accounts = getAccounts();
    if (accounts.length === 0) {
      logger.warn('Нет аккаунтов (ACCOUNTS пуст) — ночной прогон пропущен, жду минуту.');
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    try {
      await runNightly(notifier, accounts);
    } catch (e) {
      logger.error(`Ошибка ночного прогона: ${e.stack || e.message}`);
      await notifier.alert(runFailureBody(e.message)).catch(() => {});
      // короткая пауза, чтобы не уйти в горячий цикл при системном сбое
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

export default startScheduler;
