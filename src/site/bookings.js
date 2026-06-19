import { logger } from '../logger.js';

const ACCOUNT_PATH = '/rinki/minsk/account/';

const ASSORT_FLAGS = [
  ['f_kartof', 'картофель'],
  ['f_ovosh', 'овощи'],
  ['f_zelen', 'зелень'],
  ['f_plod', 'плоды'],
  ['f_yagody', 'ягоды'],
  ['f_yabloki', 'яблоки'],
];

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&laquo;|&raquo;/g, '"').replace(/\s+/g, ' ').trim();
}

// Парсинг таблицы броней «Для Вас забронированы следующие места» (table#zajav).
// Строка: <tr key="id"> [checkbox] [дата YYYY-MM-DD] [рынок] [тип места] [6 чекбоксов ассортимента].
export function parseBookings(html) {
  const table = html.match(/<table[^>]*id=["']zajav["'][\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const bookings = [];
  for (const row of table.matchAll(/<tr\s+key=["'](\d+)["']>([\s\S]*?)<\/tr>/gi)) {
    const key = row[1];
    const body = row[2];
    const date = body.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const tds = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    const market = stripTags(tds[2] || '');
    const placeType = stripTags(tds[3] || '');
    const assort = ASSORT_FLAGS.filter(([flag]) => new RegExp(`${flag}[^>]*checked`, 'i').test(body)).map(([, label]) => label);
    bookings.push({ key, date, market, placeType, assort });
  }
  return bookings;
}

// Загрузить актуальный список броней аккаунта.
export async function getBookings(client) {
  const acc = await client.get(ACCOUNT_PATH, { followRedirect: true });
  return parseBookings(acc.text);
}

// Есть ли бронь на дату с нужным рынком/ассортиментом.
// date — 'YYYY-MM-DD', marketIncludes — подстрока названия (напр. 'Комаровский').
export function findBooking(bookings, { date, marketIncludes, assort } = {}) {
  return bookings.find(
    (b) =>
      (!date || b.date === date) &&
      (!marketIncludes || b.market.includes(marketIncludes)) &&
      (!assort || b.assort.includes(assort)),
  );
}

// Подтверждение успеха подачи: появилась ли бронь на нужную дату.
export async function verifyBooking(client, { date, marketIncludes = 'Комаровский', assort = 'овощи' }) {
  const bookings = await getBookings(client);
  const found = findBooking(bookings, { date, marketIncludes, assort });
  if (found) {
    logger.info(`✅ Подтверждено: бронь на ${found.date}, ${found.market}, ${found.placeType}, ассортимент: ${found.assort.join('/')}`);
  } else {
    logger.warn(`❌ Брони на ${date} (${marketIncludes}, ${assort}) в кабинете не найдено`);
  }
  return found || null;
}

export default getBookings;
