import { DateTime } from 'luxon';
import { login } from './site/auth.js';
import { readMarketState } from './site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from './site/order.js';
import { verifyBooking } from './site/bookings.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Логирование с префиксом аккаунта, чтобы в общем потоке было видно, кто что делает.
function alog(tag, msg, level = 'info') {
  logger[level](`[${tag}] ${msg}`);
}

// Подготовка аккаунта: вход и создание изолированной сессии (свой SiteClient).
export async function prepareAccount(account) {
  const tag = account.login;
  const { client, loggedIn, fio } = await login(account.login, account.password);
  if (loggedIn) alog(tag, `сессия готова (${fio || tag})`);
  else alog(tag, 'вход не удался', 'warn');
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
