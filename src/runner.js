import { DateTime } from 'luxon';
import { login, restoreSession } from './site/auth.js';
import { readMarketState, getTypeMest } from './site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from './site/order.js';
import { verifyBooking } from './site/bookings.js';
import { loadSession, saveSession, markDone, isDone } from './session.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Логирование с префиксом аккаунта, чтобы в общем потоке было видно, кто что делает.
function alog(tag, msg, level = 'info') {
  logger[level](`[${tag}] ${msg}`);
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

// Подготовка аккаунта: вход и создание изолированной сессии (свой SiteClient).
// Сначала пробуем восстановить сессию из Redis (без лишнего логина); если кука
// устарела или её нет — обычный вход, и свежую куку сохраняем в Redis.
// predicted — предвычисленная дата брони {day,month,year,dateStr} для прогрева (этап 12).
export async function prepareAccount(account, { predicted } = {}) {
  const tag = account.login;
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
}

// Собрать дату YYYY-MM-DD из дня и месяца/года календаря.
function buildDateStr(day, month, year) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

// Обработка ответа на create_zajav: dry-run / отклонение / верификация в ЛК.
// Общая часть для быстрого (00:00) и полного (долбёжка) путей.
async function handleSubmit(ctx, attempt, sub, dateStr) {
  const { tag, client } = ctx;
  if (sub.dryRun) {
    alog(tag, `попытка ${attempt}: dry-run, заявка собрана на ${dateStr}`);
    return { tag, success: true, dryRun: true, date: dateStr };
  }
  if (!sub.accepted) {
    alog(tag, `попытка ${attempt}: сервер отклонил (code=${sub.response?.code})`, 'warn');
    return { tag, success: false, reason: 'rejected', response: sub.response, date: dateStr };
  }
  // Верификация по факту в ЛК (после подачи, вне «горячего» окна).
  const found = await verifyBooking(client, { date: dateStr });
  if (found) {
    await markDone(tag, dateStr);
    alog(tag, `✅ заявка подтверждена в ЛК: ${found.date}, ${found.market}`);
    return { tag, success: true, date: dateStr, booking: found };
  }
  alog(tag, 'заявка отправлена, но в ЛК не подтверждена', 'warn');
  return { tag, success: false, reason: 'not_verified', date: dateStr };
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
      alog(tag, `⏱ от 00:00 до подачи: ${sinceMidnight >= 0 ? '+' : ''}${sinceMidnight} мс (1 запрос create_zajav)`);
    }
    const sub = await submitOrder(client, payload, { dryRun: config.timing.dryRun });
    return handleSubmit(ctx, attempt, sub, dateStr);
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

  const sub = await submitOrder(client, payload, { dryRun: config.timing.dryRun });
  return handleSubmit(ctx, attempt, sub, dateStr);
}

// Параллельная подготовка всех аккаунтов (изолированные сессии).
// opts.predicted прокидывается в прогрев каждого аккаунта (этап 12).
export async function prepareAll(accounts, opts = {}) {
  return Promise.all(accounts.map((a) => prepareAccount(a, opts)));
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
