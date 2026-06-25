import { DateTime } from 'luxon';
import { login, restoreSession } from './site/auth.js';
import { readMarketState, getTypeMest } from './site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from './site/order.js';
import { getBookings } from './site/bookings.js';
import { loadSession, saveSession, markDone, isDone } from './session.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Логирование с префиксом аккаунта, чтобы в общем потоке было видно, кто что делает.
function alog(tag, msg, level = 'info') {
  logger[level](`[${tag}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Рандомизированная пауза-маскировка перед второй+ заявкой (этап 17). Берём целое
// число мс из [minMs, maxMs] (границы устойчивы к перестановке). 0, если маскировка
// выключена (maxMs<=0). Случайность важна: фикс. разрыв сам по себе оставляет след.
function maskGapMs() {
  const { minMs, maxMs } = config.timing.submitGap;
  if (maxMs <= 0) return 0;
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Прогрев аккаунта (этап 12): всё, что можно сделать заранее, чтобы в 00:00 ушёл
// единственный запрос — create_zajav. Заранее тянем поля формы и тип места, и
// кладём предвычисленную дату брони в ctx. Сбой прогрева не критичен — в 00:00
// сработает полный путь (чтение рынка), просто медленнее.
async function warmupAccount(ctx, predicted) {
  const { tag, client } = ctx;
  try {
    const [fields, tm] = await Promise.all([
      getRegFields(client),
      getTypeMest(client, config.site.rinokId),
    ]);
    ctx.fields = fields;
    ctx.defaultType = tm.types[0]?.value ?? 2;
    ctx.predicted = predicted;
    alog(
      tag,
      `прогрет: поля формы загружены, тип места=${ctx.defaultType}, дата брони (прогноз)=${predicted.dateStr} — в 00:00 уйдёт только подача`,
    );
  } catch (e) {
    alog(tag, `прогрев не удался (${e.message}) — в 00:00 пойдёт полный путь`, 'warn');
  }
}

// Прогрев соединения за несколько секунд до 00:00 (этап 14): лёгкий запрос к
// странице подачи «оживляет» TCP/TLS-сокет (если Apache закрыл его за время
// простоя — переустановка происходит здесь, вне критического окна), и заодно
// освежает поля формы. В 00:00 create_zajav уходит по горячему сокету за 1 RTT.
export async function warmConnection(ctx) {
  if (!ctx?.loggedIn || !ctx.client) return;
  try {
    ctx.fields = await getRegFields(ctx.client);
    alog(ctx.tag, 'соединение прогрето перед 00:00 (поля освежены)');
  } catch (e) {
    alog(ctx.tag, `прогрев соединения не удался (${e.message}) — выстрел по как есть`, 'warn');
  }
}

// Подготовка аккаунта: вход и создание изолированной сессии (свой SiteClient).
// Сначала пробуем восстановить сессию из Redis (без лишнего логина); если кука
// устарела или её нет — обычный вход, и свежую куку сохраняем в Redis.
// predicted — предвычисленная дата брони {day,month,year,dateStr} для прогрева (этап 12).
export async function prepareAccount(account, { predicted } = {}) {
  const tag = account.login;
  // Подготовка изолирована: сетевой сбой/исключение на одном аккаунте не должен
  // ронять всю ночь (см. prepareAll). При ошибке — безопасный ctx с loggedIn:false.
  try {
    let ctx;

    const saved = await loadSession(tag);
    if (saved) {
      const r = await restoreSession(saved);
      if (r.loggedIn) {
        alog(tag, `сессия восстановлена из Redis (${r.fio || tag}) — логин не потребовался`);
        ctx = { account, tag, client: r.client, loggedIn: true, fio: r.fio, restored: true };
      } else {
        await r.client.close().catch(() => {});
        alog(tag, 'сохранённая сессия устарела — выполняю вход', 'warn');
      }
    }

    if (!ctx) {
      const { client, loggedIn, fio } = await login(account.login, account.password);
      if (loggedIn) {
        await saveSession(tag, client.cookies);
        alog(tag, `сессия готова (${fio || tag}), кука сохранена в Redis`);
      } else {
        alog(tag, 'вход не удался', 'warn');
      }
      ctx = { account, tag, client, loggedIn, fio };
    }

    // Прогрев только для залогиненного аккаунта и когда известна целевая дата.
    if (ctx.loggedIn && predicted) await warmupAccount(ctx, predicted);
    return ctx;
  } catch (e) {
    alog(tag, `подготовка не удалась (${e.message}) — аккаунт пропущен в эту подачу`, 'warn');
    return { account, tag, client: null, loggedIn: false, fio: null, error: e };
  }
}

// Собрать дату YYYY-MM-DD из дня и месяца/года календаря.
function buildDateStr(day, month, year) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

// Подача N мест на одну дату (N = config.site.bookingsPerAccount) + верификация
// числа броней в ЛК. Общая часть для быстрого (00:00) и полного (долбёжка) путей.
async function submitBookings(ctx, attempt, payload, dateStr) {
  const { tag, client } = ctx;
  const n = config.site.bookingsPerAccount;
  const dryRun = config.timing.dryRun;

  // N заявок = N слотов на одну дату. 1-я уходит сразу в 00:00 (гонка не страдает);
  // каждая следующая — после паузы-маскировки (этап 17), чтобы в утренних списках
  // админов не было «мгновенного дубля» одного имени. Время каждой заявки «от 00:00»
  // фиксируем (submitTimesMs) для отчёта тайминга жене/мужу/разработчику (этап 18).
  const subs = [];
  const submitTimesMs = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const gap = maskGapMs();
      if (gap > 0) {
        alog(tag, `маскировка: пауза ${gap} мс перед заявкой ${i + 1} из ${n}`);
        await sleep(gap);
      }
    }
    submitTimesMs.push(ctx.targetMs != null ? Date.now() - ctx.targetMs : null);
    subs.push(await submitOrder(client, payload, { dryRun }));
  }

  if (dryRun) {
    alog(tag, `попытка ${attempt}: dry-run, собрано ${n} заявк(и) на ${dateStr}`);
    return { tag, success: true, dryRun: true, date: dateStr, count: n, submitTimesMs };
  }

  const acceptedCount = subs.filter((s) => s.accepted).length;
  if (acceptedCount === 0) {
    alog(tag, `попытка ${attempt}: сервер отклонил все ${n} (code=${subs[0]?.response?.code})`, 'warn');
    return { tag, success: false, reason: 'rejected', response: subs[0]?.response, date: dateStr, submitTimesMs };
  }

  // Верификация по факту в ЛК (после подачи, вне «горячего» окна): сколько броней
  // на нужную дату (Комаровский, овощи).
  const bookings = await getBookings(client);
  const found = bookings.filter(
    (b) => b.date === dateStr && b.market.includes('Комаровский') && b.assort.includes('овощи'),
  );
  // Подавали — больше в эту ночь по дате не повторяем (стоп долбёжки).
  if (acceptedCount > 0) await markDone(tag, dateStr);

  if (found.length >= n) {
    alog(tag, `✅ подтверждено в ЛК: ${found.length} из ${n} мест на ${dateStr}, ${found[0].market}`);
    return { tag, success: true, date: dateStr, count: found.length, booking: found[0], submitTimesMs };
  }
  if (found.length > 0) {
    alog(tag, `⚠ частично: в ЛК ${found.length} из ${n} мест на ${dateStr} (сервер принял ${acceptedCount})`, 'warn');
    return { tag, success: false, reason: 'partial', date: dateStr, count: found.length, submitTimesMs };
  }
  alog(tag, `заявки отправлены (принято ${acceptedCount}), но в ЛК на ${dateStr} ничего не подтверждено`, 'warn');
  return { tag, success: false, reason: 'not_verified', date: dateStr, count: 0, submitTimesMs };
}

// Одна попытка подачи для подготовленного аккаунта.
// Возвращает {success, reason, ...}. success=true только при реальном подтверждении
// (или в dry-run, когда запрос собран).
//
// Этап 12: первый выстрел (attempt=1) с прогретым ctx идёт по БЫСТРОМУ пути —
// в 00:00 уходит единственный запрос create_zajav (поля и тип взяты в прогреве,
// дата предвычислена). Если прогрева нет или это долбёжка (attempt>1) — ПОЛНЫЙ путь
// с чтением рынка: так сохраняется поведение «дата ещё не открылась» и коррекция
// прогноза по реальному календарю.
export async function attemptForAccount(ctx, attempt = 1) {
  const { tag, client, loggedIn } = ctx;
  if (!loggedIn) return { tag, success: false, reason: 'not_logged_in' };

  // --- Быстрый путь: только подача (этап 12) ---
  if (attempt === 1 && ctx.fields && ctx.predicted) {
    const { day, month, year, dateStr } = ctx.predicted;
    const payload = buildCreateZajavPayload({
      fields: ctx.fields,
      rinokId: config.site.rinokId,
      typeMesta: ctx.defaultType || 2,
      day,
      month,
      year,
      assortIds: config.site.assortIds,
    });
    // Замер «от 00:00 до подачи»: время от целевой полуночи до отправки запроса.
    const sinceMidnight = ctx.targetMs != null ? Date.now() - ctx.targetMs : null;
    if (sinceMidnight != null) {
      alog(tag, `⏱ от 00:00 до подачи: ${sinceMidnight >= 0 ? '+' : ''}${sinceMidnight} мс (${config.site.bookingsPerAccount} запрос(ов) create_zajav)`);
    }
    const r = await submitBookings(ctx, attempt, payload, dateStr);
    if (sinceMidnight != null) r.submitMs = sinceMidnight; // для отчёта тайминга разработчику
    return r;
  }

  // --- Полный путь: чтение рынка → поля → подача (долбёжка / нет прогрева) ---
  const state = await readMarketState(client, config.site.rinokId);
  if (!state.availableDays || state.availableDays.length === 0) {
    alog(tag, `попытка ${attempt}: дат нет`, 'warn');
    return { tag, success: false, reason: 'no_date' };
  }

  const day = state.availableDays[0];
  const dateStr = buildDateStr(day, state.month, state.year);

  // Защита от двойной подачи: на повторных попытках (долбёжка/рестарт) проверяем,
  // не подавали ли уже на эту дату.
  if (attempt > 1 && (await isDone(tag, dateStr))) {
    alog(tag, `на ${dateStr} уже подано ранее — повтор пропущен`);
    return { tag, success: true, date: dateStr, alreadyDone: true };
  }

  const fields = await getRegFields(client);
  const payload = buildCreateZajavPayload({
    fields,
    rinokId: config.site.rinokId,
    typeMesta: state.defaultType || 2,
    day,
    month: state.month,
    year: state.year,
    assortIds: config.site.assortIds,
  });

  return submitBookings(ctx, attempt, payload, dateStr);
}

// Параллельная подготовка всех аккаунтов (изолированные сессии).
// opts.predicted прокидывается в прогрев каждого аккаунта (этап 12).
// allSettled — страховка: даже неожиданное исключение в одном аккаунте не
// отменяет подготовку остальных (prepareAccount и сам не бросает).
export async function prepareAll(accounts, opts = {}) {
  const settled = await Promise.allSettled(accounts.map((a) => prepareAccount(a, opts)));
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { account: accounts[i], tag: accounts[i].login, client: null, loggedIn: false, error: s.reason },
  );
}

// Параллельная подача по всем подготовленным аккаунтам.
export async function attemptAll(contexts, attempt = 1) {
  return Promise.all(contexts.map((ctx) => attemptForAccount(ctx, attempt)));
}

// Закрыть все сессии.
export async function closeAll(contexts) {
  await Promise.all(contexts.map((ctx) => ctx.client?.close().catch(() => {})));
}

export { buildDateStr };
