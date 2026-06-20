// Все пользовательские тексты Telegram-бота в одном месте (этап 13).
// Стиль: минимум смайлов (только функциональные статус-индикаторы 🟢/🔴/🟡),
// форматирование через HTML (parse_mode: 'HTML'): <b>, <i>, <u>, <code>.
// Подставляемые значения экранируем esc() — Telegram HTML требует &<> экранировать.
import { DateTime } from 'luxon';
import { config } from './config.js';

const ASSORT_LABELS = { 1: 'картофель', 2: 'овощи', 3: 'зелень', 4: 'плоды', 5: 'ягоды', 6: 'яблоки' };

// Экранирование для Telegram HTML.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function assortText() {
  return config.site.assortIds.map((id) => ASSORT_LABELS[id] || `ассортимент ${id}`).join(', ');
}

// Дата прописью с днём недели: "воскресенье, 21 июня 2026" (день недели важен —
// по понедельникам рынок не работает).
export function bookingDateLong(dateStr) {
  if (!dateStr) return '—';
  const d = DateTime.fromISO(dateStr).setLocale('ru');
  return d.isValid ? d.toFormat('cccc, d MMMM yyyy') : dateStr;
}

// Краткая дата для строки состояния: "21 июня".
export function bookingDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = DateTime.fromISO(dateStr).setLocale('ru');
  return d.isValid ? d.toFormat('d MMMM') : dateStr;
}

function modeLabel(dryRun) {
  return dryRun
    ? '<i>тест</i> (заявки на сайт не отправляются)'
    : '<b>рабочий</b> (заявки отправляются на сайт)';
}

// Ответ на /start — подписка чата на уведомления.
export function startReply() {
  return [
    '<b>bron-bot на связи</b>',
    '',
    'Этот чат подписан на уведомления о ночной брони торгового места.',
    'Каждую ночь после 00:00 пришлю результат подачи.',
    '',
    'Команда /status — состояние бота и время следующей подачи.',
  ].join('\n');
}

// Уведомление при запуске бота на сервере.
export function startedNotice({ nextRun, dryRun, accounts }) {
  return [
    '<b>bron-bot запущен</b>',
    '',
    `Следующая подача: <code>${esc(nextRun)}</code>`,
    `Режим: ${modeLabel(dryRun)}`,
    `Кабинетов: ${accounts}`,
  ].join('\n');
}

// Уведомление при остановке бота.
export function stoppedNotice() {
  return '<b>bron-bot остановлен.</b> Уведомления приостановлены.';
}

// Ответ на /status — состояние бота.
export function statusText({ uptimeMs, nextRun, accounts, dryRun, lastRun } = {}) {
  const lines = ['<b>bron-bot · состояние</b>', ''];
  if (uptimeMs != null) lines.push(`Бот работает: ${humanDuration(uptimeMs)} без перерыва`);
  if (nextRun) lines.push(`Следующая подача: <code>${esc(nextRun)}</code>`);
  if (accounts != null) lines.push(`Кабинетов: ${accounts}`);
  lines.push(`Режим: ${modeLabel(dryRun)}`);
  lines.push(`Последняя подача: ${lastRun ? esc(lastRun.title) : 'ещё не было'}`);
  return lines.join('\n');
}

// Исход подачи по одному аккаунту (одна строка). Статус-индикатор — единственный смайл.
// date — дата подачи (общая для прогона), используется как запасная, если у самого
// результата даты нет.
export function outcomeText(r, date) {
  const when = bookingDateShort(r.booking?.date || r.date || date);
  if (r.success && r.dryRun) {
    return `<i>тест — заявка собрана на ${when} (в рабочем режиме ушла бы на сайт)</i>`;
  }
  if (r.success) return `🟢 место забронировано на <b>${when}</b>`;
  const reasons = {
    no_date: '🔴 свободных дат не было',
    rejected: '🔴 сайт отклонил заявку',
    not_verified: '🟡 заявка отправлена, но не подтвердилась в личном кабинете',
    not_logged_in: '🔴 не удалось войти в кабинет',
    error: '🔴 сетевая ошибка при подаче',
  };
  return reasons[r.reason] || `🔴 ${esc(r.reason || 'неизвестная причина')}`;
}

// Итог ночной подачи по всем аккаунтам.
export function runResultText(results, { dryRun = false, date } = {}) {
  const okCount = results.filter((r) => r.success).length;
  const lines = [`<b>Итог ночной подачи</b>${dryRun ? ' <i>(тест)</i>' : ''}`];
  if (date) lines.push(`Дата брони: <code>${esc(bookingDateLong(date))}</code>`);
  lines.push(`Ассортимент: ${esc(assortText())} · Рынок: ${esc(config.site.marketName)}`);
  lines.push('');
  for (const r of results) {
    lines.push(`<b>${esc(r.fio || r.tag)}</b>`);
    lines.push(outcomeText(r, date));
  }
  lines.push('');
  if (okCount < results.length) {
    lines.push('<b>Часть заявок не прошла.</b> <u>Подайте вручную.</u>');
  } else if (dryRun) {
    lines.push('<i>Тест-режим: реальные заявки не отправлялись.</i>');
  } else {
    lines.push('<b>Готово: все места взяты.</b>');
  }
  return lines.join('\n');
}

// Заметный префикс для тревожных сообщений.
export function alertText(body) {
  return `<b>⚠ ВНИМАНИЕ</b>\n${body}`;
}

// Тело алерта о возможной блокировке IP (серия ошибок на подаче).
export function blockAlertBody({ account, streak }) {
  return (
    `Кабинет <b>${esc(account)}</b>: ${streak} ошибок подряд при подаче — возможна блокировка IP.\n` +
    '<u>Проверьте доступ к сайту и при необходимости подайте вручную.</u>'
  );
}

// Тело алерта о сбое ночного прогона.
export function runFailureBody(message) {
  return `Сбой ночного прогона: <code>${esc(message)}</code>\nБот продолжит работу и попробует в следующую ночь.`;
}

function humanDuration(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}
