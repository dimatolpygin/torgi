// Все пользовательские тексты Telegram-бота в одном месте (этап 13).
// Стиль: единый, со смайлами к месту, формулировки однозначны (в т.ч. чёткое
// отличие тест-режима от боевого). Plain text — без parse_mode, спецсимволы не нужны.
import { DateTime } from 'luxon';
import { config } from './config.js';

const ASSORT_LABELS = { 1: 'картофель', 2: 'овощи', 3: 'зелень', 4: 'плоды', 5: 'ягоды', 6: 'яблоки' };

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
  return dryRun ? '🧪 тест (заявки на сайт не отправляются)' : '🔥 рабочий (заявки отправляются на сайт)';
}

function humanDuration(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

// Ответ на /start — подписка чата на уведомления.
export function startReply() {
  return [
    '✅ bron-bot на связи!',
    '',
    'Этот чат подписан на уведомления о ночной брони торгового места.',
    'Каждую ночь после 00:00 пришлю результат: 🟢 место взято или 🔴 не вышло.',
    '',
    '📋 /status — состояние бота и время следующей подачи.',
  ].join('\n');
}

// Уведомление при запуске бота на сервере.
export function startedNotice({ nextRun, dryRun, accounts }) {
  return [
    '🚀 bron-bot запущен на сервере.',
    '',
    `🗓 следующая подача: ${nextRun}`,
    `⚙️ режим: ${modeLabel(dryRun)}`,
    `👥 кабинетов: ${accounts}`,
  ].join('\n');
}

// Уведомление при остановке бота.
export function stoppedNotice() {
  return '🛑 bron-bot остановлен на сервере. Уведомления приостановлены.';
}

// Ответ на /status — состояние бота.
export function statusText({ uptimeMs, nextRun, accounts, dryRun, lastRun } = {}) {
  const lines = ['🤖 bron-bot · состояние', ''];
  if (uptimeMs != null) lines.push(`🟢 бот работает: ${humanDuration(uptimeMs)} без перерыва`);
  if (nextRun) lines.push(`🗓 следующая подача: ${nextRun}`);
  if (accounts != null) lines.push(`👥 кабинетов: ${accounts}`);
  lines.push(`⚙️ режим: ${modeLabel(dryRun)}`);
  lines.push(`📨 последняя подача: ${lastRun ? lastRun.title : 'ещё не было'}`);
  return lines.join('\n');
}

// Исход подачи по одному аккаунту (одна строка).
export function outcomeText(r) {
  if (r.success && r.dryRun) {
    return '🧪 тест — заявка корректно собрана (в боевом режиме ушла бы на сайт)';
  }
  if (r.success) {
    return '🟢 место забронировано';
  }
  const reasons = {
    no_date: '🔴 свободных дат не было',
    rejected: '🔴 сайт отклонил заявку',
    not_verified: '🟡 заявка отправлена, но не подтвердилась в личном кабинете',
    not_logged_in: '🔴 не удалось войти в аккаунт',
    error: '🔴 сетевая ошибка при подаче',
  };
  return reasons[r.reason] || `🔴 ${r.reason || 'неизвестная причина'}`;
}

// Итог ночной подачи по всем аккаунтам.
export function runResultText(results, { dryRun = false, date } = {}) {
  const okCount = results.filter((r) => r.success).length;
  const lines = [`🌙 bron-bot · итог ночной подачи${dryRun ? ' · 🧪 тест' : ''}`];
  if (date) lines.push(`🗓 дата брони: ${bookingDateLong(date)}`);
  lines.push(`🥬 ${assortText()} · 🏪 ${config.site.marketName}`);
  lines.push('');
  for (const r of results) {
    lines.push(`👤 ${r.fio || r.tag}`);
    lines.push(`   ${outcomeText(r)}`);
  }
  lines.push('');
  if (okCount < results.length) {
    lines.push('⚠️ Часть заявок не прошла — подайте вручную!');
  } else if (dryRun) {
    lines.push('🧪 Тест-режим: реальные заявки не отправлялись.');
  } else {
    lines.push('✅ Готово: все места взяты.');
  }
  return lines.join('\n');
}

// Заметный префикс для тревожных сообщений.
export function alertText(body) {
  return `🚨 ВНИМАНИЕ!\n${body}`;
}

// Тело алерта о возможной блокировке IP (серия ошибок на подаче).
export function blockAlertBody({ account, streak }) {
  return (
    `Аккаунт ${account}: ${streak} ошибок подряд при подаче — возможна блокировка IP.\n` +
    'Проверьте доступ к сайту и при необходимости подайте вручную.'
  );
}

// Тело алерта о сбое ночного прогона.
export function runFailureBody(message) {
  return `Сбой ночного прогона: ${message}\nБот продолжит работу и попробует в следующую ночь.`;
}
