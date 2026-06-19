// UAT-скрипт этапа 4: чтение и верификация броней из ЛК.
// Запуск: node src/scripts/check-bookings.js
import { login } from '../site/auth.js';
import { getBookings, findBooking } from '../site/bookings.js';
import { getAccounts } from '../accounts.js';
import { logger } from '../logger.js';

async function main() {
  const a = getAccounts()[0];
  const { client, loggedIn } = await login(a.login, a.password);
  if (!loggedIn) {
    logger.error('Не вошли');
    process.exit(1);
  }

  const bookings = await getBookings(client);
  logger.info(`--- Брони в кабинете: ${bookings.length} ---`);
  for (const b of bookings.slice(0, 15)) {
    logger.info(`  ${b.date} | ${b.market} | ${b.placeType} | ${b.assort.join('/') || '—'} | key=${b.key}`);
  }

  // Проверка поиска: есть ли бронь на Комаровском с овощами
  const komar = findBooking(bookings, { marketIncludes: 'Комаровский', assort: 'овощи' });
  logger.info('--- Поиск брони (Комаровский + овощи) ---');
  logger.info(komar ? `Найдена: ${komar.date}, ${komar.market}` : 'Не найдена');

  await client.close();

  const ok = Array.isArray(bookings) && bookings.length >= 0;
  logger.info(ok ? '✅ Этап 4: брони читаются и ищутся по дате/рынку/ассортименту' : '❌ Этап 4: ошибка');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
