// UAT этап 13: визуальная проверка ВСЕХ текстов Telegram-бота без отправки.
// Запуск: node src/scripts/check-messages.js
//
// Печатает каждое сообщение так, как его увидит клиент. Глазами проверяем:
// единый стиль, смайлы к месту, отсутствие двусмысленностей. Реальную отправку
// в Telegram для UAT по скриншотам делает check-telegram.js.
import {
  startReply,
  startedNotice,
  stoppedNotice,
  statusText,
  runResultText,
  alertText,
  blockAlertBody,
  runFailureBody,
} from '../messages.js';

const sep = (title) => `\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`;
// В консоли убираем HTML-теги (в Telegram они отрисуются как форматирование),
// &-сущности возвращаем обратно — чтобы видеть текст глазами клиента.
const strip = (t) =>
  t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const show = (title, text) => {
  console.log(sep(title));
  console.log(strip(text));
};

const fio1 = 'Иванов Александр Эдуардович';
const fio2 = 'Иванова Мария Петровна';

show('/start — приветствие', startReply());

show('Запуск на сервере (боевой)', startedNotice({ nextRun: 'вторник 23.06.2026 00:00', dryRun: false, accounts: 2 }));
show('Запуск на сервере (тест)', startedNotice({ nextRun: 'вторник 23.06.2026 00:00', dryRun: true, accounts: 1 }));

show('Остановка', stoppedNotice());

show('/status (боевой, был прогон)', statusText({ uptimeMs: 3 * 3600_000 + 12 * 60_000, nextRun: 'вторник 23.06.2026 00:00', accounts: 2, dryRun: false, lastRun: { title: '2026-06-23 — успех (2/2)' } }));
show('/status (тест, прогонов не было)', statusText({ uptimeMs: 5 * 60_000, nextRun: 'вторник 23.06.2026 00:00', accounts: 1, dryRun: true, lastRun: null }));

show('Итог: оба успешно (боевой)', runResultText(
  [
    { fio: fio1, success: true, booking: { market: 'Комаровский' } },
    { fio: fio2, success: true, booking: { market: 'Комаровский' } },
  ],
  { dryRun: false, date: '2026-06-23' },
));

show('Итог: один не прошёл (боевой)', runResultText(
  [
    { fio: fio1, success: true, booking: { market: 'Комаровский' } },
    { fio: fio2, success: false, reason: 'rejected' },
  ],
  { dryRun: false, date: '2026-06-23' },
));

show('Итог: разные исходы (боевой)', runResultText(
  [
    { fio: fio1, success: false, reason: 'no_date' },
    { fio: fio2, success: false, reason: 'not_verified' },
  ],
  { dryRun: false, date: '2026-06-23' },
));

show('Итог: тест-режим', runResultText(
  [
    { fio: fio1, success: true, dryRun: true },
    { fio: fio2, success: true, dryRun: true },
  ],
  { dryRun: true, date: '2026-06-23' },
));

show('Алерт: возможная блокировка IP', alertText(blockAlertBody({ account: fio2, streak: 5 })));
show('Алерт: сбой прогона', alertText(runFailureBody('ECONNRESET')));

console.log('\n✅ Все тексты сгенерированы — проверьте формулировки и смайлы выше.');
