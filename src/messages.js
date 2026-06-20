// Все пользовательские тексты Telegram-бота в одном месте (этап 13).
// Стиль: единый, со смайлами к месту, формулировки однозначны (в т.ч. чёткое
// отличие тест-режима от боевого). Plain text — без parse_mode, спецсимволы не нужны.

function modeLabel(dryRun) {
  return dryRun ? '🧪 тест (заявки на сайт не отправляются)' : '🔥 боевой (заявки отправляются)';
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
    `👥 аккаунтов: ${accounts}`,
  ].join('\n');
}

// Уведомление при остановке бота.
export function stoppedNotice() {
  return '🛑 bron-bot остановлен на сервере. Уведомления приостановлены.';
}

// Ответ на /status — состояние бота.
export function statusText({ uptimeMs, nextRun, accounts, dryRun, lastRun } = {}) {
  const lines = ['🤖 bron-bot · состояние', ''];
  if (uptimeMs != null) lines.push(`⏱ аптайм: ${humanDuration(uptimeMs)}`);
  if (nextRun) lines.push(`🗓 следующая подача: ${nextRun}`);
  if (accounts != null) lines.push(`👥 аккаунтов: ${accounts}`);
  lines.push(`⚙️ режим: ${modeLabel(dryRun)}`);
  lines.push(`📨 последний прогон: ${lastRun ? lastRun.title : 'ещё не было'}`);
  return lines.join('\n');
}

// Исход подачи по одному аккаунту (одна строка).
export function outcomeText(r) {
  if (r.success && r.dryRun) {
    return '🧪 тест — заявка корректно собрана (в боевом режиме ушла бы на сайт)';
  }
  if (r.success) {
    const b = r.booking;
    return `🟢 место забронировано${b?.market ? ` · ${b.market}` : ''}`;
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
  if (date) lines.push(`🗓 дата брони: ${date}`);
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
