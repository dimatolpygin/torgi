// Разведка состояния всех аккаунтов из ACCOUNTS (только чтение).
// Для каждого: вход, ФИО, всего броней, доступная дата, брони на эту дату.
// Запуск: ACCOUNTS="login1:pass1,login2:pass2" node src/scripts/check-accounts-state.js
import { login } from '../site/auth.js';
import { readMarketState } from '../site/market.js';
import { getBookings } from '../site/bookings.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const pad = (n) => String(n).padStart(2, '0');

async function main() {
  const accounts = getAccounts();
  if (accounts.length === 0) { logger.error('ACCOUNTS пуст'); process.exit(1); }
  logger.info(`Аккаунтов в ACCOUNTS: ${accounts.length}`);

  for (const a of accounts) {
    logger.info(`\n=== Аккаунт ${a.login} ===`);
    const { client, loggedIn, fio } = await login(a.login, a.password);
    if (!loggedIn) { logger.error(`  ВХОД НЕ УДАЛСЯ (проверь пароль)`); continue; }
    logger.info(`  Вход OK: ${fio}`);

    const state = await readMarketState(client, config.site.rinokId);
    const day = state.availableDays[0];
    const dateStr = day ? `${state.year}-${pad(state.month)}-${pad(day)}` : null;
    logger.info(`  Доступная дата на Комаровском: ${dateStr || 'нет'} (лимит ${state.limit})`);

    const bookings = await getBookings(client);
    logger.info(`  Всего броней в ЛК: ${bookings.length}`);
    if (dateStr) {
      const onDate = bookings.filter((b) => b.date === dateStr);
      const komar = onDate.filter((b) => b.market.includes('Комаровский'));
      logger.info(`  На ${dateStr}: всего ${onDate.length}, Комаровский ${komar.length}`);
      komar.forEach((b) => logger.info(`     ${b.date} | ${b.market} | ${b.placeType} | ${b.assort.join('/')} | key=${b.key}`));
    }
    await client.close();
  }
  process.exit(0);
}
main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
