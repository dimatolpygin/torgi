import { DateTime } from 'luxon';
import { config, accountRole } from './config.js';
import { logger } from './logger.js';
import { getAccounts } from './accounts.js';
import { prepareAll, attemptForAccount, closeAll, buildDateStr, warmConnection } from './runner.js';
import { recordAttempt } from './db.js';
import { nextRegistrationMidnight, waitUntil, fireAt, retryUntil } from './scheduler.js';
import { blockAlertBody, runFailureBody, preflightNotice, timingNotice, accountTimingNotice } from './messages.js';
import { SiteClient } from './site/client.js';
import { measureSiteClockOffset, formatClockOffset, measureRtt, formatRtt } from './site/clock.js';

// Подача по одному аккаунту: первая попытка в 00:00, при неуспехе — безопасная
// долбёжка (этап 5). Серия сетевых ошибок (возможная блокировка IP) → алерт.
// Алерт шлём один раз за ночь, чтобы не спамить.
async function runForContext(ctx, notifier) {
  const withFio = (r) => ({ ...r, fio: ctx.fio });

  const first = await attemptForAccount(ctx, 1).catch((e) => {
    // Раньше сбой первой попытки глотался молча (так и не увидели причину бага 26.06).
    logger.warn(`[${ctx.tag}] первая попытка завершилась ошибкой: ${e.message}`);
    return { tag: ctx.tag, success: false, reason: 'error', error: e };
  });
  if (first.success) return withFio(first);

  let alerted = false;
  // attempt = n + 1 (старт со 2): долбёжка идёт ПОЛНЫМ путём (чтение рынка), где есть
  // защита isDone от повторной подачи. Быстрый путь (attempt===1) — только выстрел в 00:00.
  const retried = await retryUntil((n) => attemptForAccount(ctx, n + 1), {
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

  // Часы vs сайт (этап 19) + RTT (этап 20) — ДИАГНОСТИКА, по умолчанию ВЫКЛЮЧЕНА.
  // Замер требует частых проб (ловим переворот секунды в заголовке Date), то есть
  // создаёт пачку запросов за две минуты до выстрела. Ночью 30.07.2026 это стоило нам
  // бана IP на час и всей ночи (0 мест из 4): в 23:58 сайт закрыл TCP, выстрел в 00:00
  // ушёл в ECONNREFUSED. На подачу замер не влияет — включать только осознанно
  // (CLOCK_PROBE=true), и уже с безопасным разрежением проб.
  let clock = null;
  let rtt = null;
  if (config.timing.clockProbe) {
    try {
      const probe = new SiteClient();
      clock = await measureSiteClockOffset(probe, { durationMs: 3000, gapMs: 200, maxFlips: 3 });
      rtt = await measureRtt(probe, { path: config.timing.rttProbePath, samples: config.timing.rttProbeSamples });
      await probe.close().catch(() => {});
      logger.info(`🕐 Часы vs сайт: ${formatClockOffset(clock)}`);
      logger.info(`📡 ${formatRtt(rtt)}`);
    } catch (e) {
      logger.warn(`Замер часов/RTT сайта не удался (${e.message}) — пропускаю`);
    }
  } else {
    logger.info('🕐 Замер часов/RTT отключён (CLOCK_PROBE≠true) — перед выстрелом не создаём лишних запросов к сайту');
  }

  // Упреждение выстрела (этап 20): стреляем на sendAhead мс РАНЬШЕ 00:00, чтобы заявка
  // прилетела ближе к 00:00:00.000 (компенсация односторонней сетевой задержки). Дефолт 0
  // = выключено (поведение как раньше). При sendAhead>one-way — предупреждаем (риск no_date,
  // но сработает безопасный фолбэк повтора в 00:00). Замер «от 00:00» и фолбэк — по истинной
  // полуночи (targetMs), стреляем по fireTargetMs.
  const sendAhead = config.timing.sendAheadMs;
  const fireTargetMs = targetMs - sendAhead;
  if (sendAhead > 0) {
    const ow = rtt?.oneWayMs;
    const risk = ow != null && sendAhead > ow ? ' ⚠ больше one-way — риск no_date (сработает фолбэк)' : '';
    logger.info(`🎯 Упреждение выстрела: ${sendAhead} мс (one-way ≈ ${ow != null ? ow.toFixed(1) : '?'} мс)${risk}`);
  }
  contexts.forEach((ctx) => {
    ctx.trueTargetMs = targetMs; // истинная полночь — для фолбэка упреждения
    ctx.sendAheadMs = sendAhead;
  });

  // Тёплое соединение за warmAheadMs до полуночи (этап 14): «оживляем» сокет,
  // чтобы create_zajav в 00:00 ушёл по горячему TLS за 1 RTT. Завершаем заранее,
  // чтобы запрос не висел на единственном соединении в момент выстрела.
  const warmAheadMs = config.timing.warmAheadMs;
  if (warmAheadMs > 0 && targetMs - Date.now() > warmAheadMs) {
    await waitUntil(targetMs - warmAheadMs);
    logger.info(`🔥 Прогрев соединения за ${warmAheadMs}мс до полуночи…`);
    await Promise.all(contexts.map((ctx) => warmConnection(ctx)));
  }

  // Точный выстрел, параллельно по всем аккаунтам. fireTargetMs = 00:00 − упреждение
  // (этап 20); при sendAhead=0 это ровно 00:00:00.000 (прежнее поведение).
  const { drift, result: results } = await fireAt(fireTargetMs, () =>
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
  // Тайминг подачи разработчику — точность выстрела + время КАЖДОЙ заявки (1-й и 2-й)
  // по КАЖДОМУ аккаунту, одним сообщением (этап 18).
  await notifier
    .notifyDev(
      timingNotice({
        drift,
        results,
        dryRun: config.timing.dryRun,
        clock,
        rtt,
        sendAhead,
        // Разбор защиты формы с прогрева (этап ext-0) — уже лежит в ctx, новых запросов нет.
        guards: contexts.map((c) => ({ tag: c.tag, guard: c.guard })),
      }),
    )
    .catch(() => {});
  // Персональный тайминг жене/мужу — каждому на ЕГО кабинет (1-я и 2-я заявка),
  // только при успехе подачи этого кабинета (этап 18). Роль аккаунта берётся из
  // ACCOUNT_ROLES; dev получает общий отчёт выше, повторно ему не шлём.
  await Promise.all(
    results.map((r) => {
      if (!r.success) return null;
      const role = accountRole(r.tag);
      if (!role || role === 'dev') return null;
      return notifier
        .notifyRole([role], accountTimingNotice(r, { date, dryRun: config.timing.dryRun }))
        .catch(() => {});
    }),
  );
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
