import { DateTime } from 'luxon';
import { login, restoreSession } from './site/auth.js';
import { readMarketState } from './site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from './site/order.js';
import { verifyBooking } from './site/bookings.js';
import { loadSession, saveSession, markDone, isDone } from './session.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Логирование с префиксом аккаунта, чтобы в общем потоке было видно, кто что делает.
function alog(tag, msg, level = 'info') {
  logger[level](`[${tag}] ${msg}`);
}

// Подготовка аккаунта: вход и создание изолированной сессии (свой SiteClient).
// Сначала пробуем восстановить сессию из Redis (без лишнего логина); если кука
// устарела или её нет — обычный вход, и свежую куку сохраняем в Redis.
export async function prepareAccount(account) {
  const tag = account.login;

  const saved = await loadSession(tag);
  if (saved) {
    const r = await restoreSession(saved);
    if (r.loggedIn) {
      alog(tag, `сессия восстановлена из Redis (${r.fio || tag}) — логин не потребовался`);
      return { account, tag, client: r.client, loggedIn: true, fio: r.fio, restored: true };
    }
    await r.client.close().catch(() => {});
    alog(tag, 'сохранённая сессия устарела — выполняю вход', 'warn');
  }

  const { client, loggedIn, fio } = await login(account.login, account.password);
  if (loggedIn) {
    await saveSession(tag, client.cookies);
    alog(tag, `сессия готова (${fio || tag}), кука сохранена в Redis`);
  } else {
    alog(tag, 'вход не удался', 'warn');
  }
  return { account, tag, client, loggedIn, fio };
}

// Собрать дату YYYY-MM-DD из дня и месяца/года календаря.
function buildDateStr(day, month, year) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

// Одна попытка подачи для подготовленного аккаунта.
// Возвращает {success, reason, ...}. success=true только при реальном подтверждении
// (или в dry-run, когда дата есть и запрос собран).
export async function attemptForAccount(ctx, attempt = 1) {
  const { tag, client, loggedIn } = ctx;
  if (!loggedIn) return { tag, success: false, reason: 'not_logged_in' };

  const state = await readMarketState(client, config.site.rinokId);
  if (!state.availableDays || state.availableDays.length === 0) {
    alog(tag, `попытка ${attempt}: дат нет`, 'warn');
    return { tag, success: false, reason: 'no_date' };
  }

  const day = state.availableDays[0];
  const dateStr = buildDateStr(day, state.month, state.year);

  // Защита от двойной подачи: на повторных попытках (долбёжка/рестарт) проверяем,
  // не подавали ли уже на эту дату. Первый выстрел в 00:00 не тормозим лишним
  // запросом в Redis — скорость важнее.
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
  if (sub.dryRun) {
    alog(tag, `попытка ${attempt}: dry-run, заявка собрана на ${dateStr}`);
    return { tag, success: true, dryRun: true, date: dateStr };
  }
  if (!sub.accepted) {
    alog(tag, `попытка ${attempt}: сервер отклонил (code=${sub.response?.code})`, 'warn');
    return { tag, success: false, reason: 'rejected', response: sub.response };
  }

  // Верификация по факту в ЛК
  const found = await verifyBooking(client, { date: dateStr });
  if (found) {
    await markDone(tag, dateStr);
    alog(tag, `✅ заявка подтверждена в ЛК: ${found.date}, ${found.market}`);
    return { tag, success: true, date: dateStr, booking: found };
  }
  alog(tag, 'заявка отправлена, но в ЛК не подтверждена', 'warn');
  return { tag, success: false, reason: 'not_verified', date: dateStr };
}

// Параллельная подготовка всех аккаунтов (изолированные сессии).
export async function prepareAll(accounts) {
  return Promise.all(accounts.map((a) => prepareAccount(a)));
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
