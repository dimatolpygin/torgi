// Минское время без внешних библиотек (в расширении нет luxon и не будет — никаких
// зависимостей, которые пришлось бы собирать). Повторяет логику бота:
// src/scheduler.js nextRegistrationMidnight + orchestrator.js (дата брони = цель + 7 дней).
//
// Часы берём с ПК клиентки — расширение не ходит в сеть за временем. Смещение зоны
// вычисляется через Intl, а не хардкодом «UTC+3»: если Беларусь когда-нибудь вернёт
// переводы часов, ничего не сломается.
//
// Файл подключается и как content script, и в popup — поэтому обычные глобальные функции,
// без import/export. Внизу — мост в CommonJS для офлайн-проверки из node.

var MINSK_TZ = 'Europe/Minsk';
var BOOKING_LEAD_DAYS = 7; // в 00:00 открывается дата на неделю вперёд (BOOKING_LEAD_DAYS бота)

// Смещение зоны в миллисекундах для конкретного момента.
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || MINSK_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUTC - (ts - (ts % 1000));
}

// Календарные части минского «сейчас».
function minskParts(ts, tz) {
  const t = ts == null ? Date.now() : ts;
  const off = tzOffsetMs(t, tz);
  const d = new Date(t + off);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay() === 0 ? 7 : d.getUTCDay(), // 1=пн … 7=вс, как в luxon
  };
}

// Момент (epoch ms) полуночи указанной календарной даты в минской зоне.
// Два прохода: смещение считается сначала по приближению, потом уточняется — так
// правильно ложится и на день перевода часов, если он когда-нибудь появится.
function minskMidnightMs(year, month, day, tz) {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

// Сдвиг календарной даты на N дней (без переполнений месяцев/годов).
function shiftDate(year, month, day, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() === 0 ? 7 : d.getUTCDay() };
}

// Ближайшая полночь, в которую ИДЁТ регистрация. В ночь на понедельник рынок не
// работает — такая полночь пропускается (совпадает с nextRegistrationMidnight бота).
function nextRegistrationMidnight(ts, tz) {
  const now = ts == null ? Date.now() : ts;
  const p = minskParts(now, tz);
  let d = shiftDate(p.year, p.month, p.day, 1);
  while (d.weekday === 1) d = shiftDate(d.year, d.month, d.day, 1);
  return { year: d.year, month: d.month, day: d.day, weekday: d.weekday, ms: minskMidnightMs(d.year, d.month, d.day, tz) };
}

// Дата, которая откроется в эту полночь: цель + 7 дней. День недели тот же, что у цели,
// поэтому на понедельник бронь не попадает никогда.
function bookingDateFor(target, leadDays) {
  const lead = leadDays == null ? BOOKING_LEAD_DAYS : leadDays;
  const d = shiftDate(target.year, target.month, target.day, lead);
  return { year: d.year, month: d.month, day: d.day, weekday: d.weekday, dateStr: buildDateStr(d.day, d.month, d.year) };
}

// Формат даты как в боте (src/runner.js buildDateStr): YYYY-MM-DD.
function buildDateStr(day, month, year) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const WEEKDAYS_RU = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS_RU = ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «12 августа, среда» — для панели, человеку.
function formatDateRu(d) {
  return `${d.day} ${MONTHS_RU[d.month]}, ${WEEKDAYS_RU[d.weekday]}`;
}

// «02:13:07» из остатка в миллисекундах (для обратного отсчёта).
function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Мост для офлайн-проверки (src/scripts/check-ext.js). В браузере ветка не срабатывает.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MINSK_TZ,
    BOOKING_LEAD_DAYS,
    tzOffsetMs,
    minskParts,
    minskMidnightMs,
    shiftDate,
    nextRegistrationMidnight,
    bookingDateFor,
    buildDateStr,
    formatDateRu,
    formatCountdown,
  };
}
