// UAT-скрипт этапа 2: чтение состояния рынка (Комаровский).
// Запуск: node src/scripts/check-market.js
import { login } from '../site/auth.js';
import { readMarketState } from '../site/market.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function main() {
  const acc = getAccounts()[0];
  if (!acc) {
    logger.error('Нет аккаунтов в ACCOUNTS (.env)');
    process.exit(1);
  }

  const { client, loggedIn } = await login(acc.login, acc.password);
  if (!loggedIn) {
    logger.error('Не удалось войти');
    process.exit(1);
  }

  logger.info(`--- Состояние рынка id=${config.site.rinokId} (Комаровский) ---`);
  const state = await readMarketState(client, config.site.rinokId);

  logger.info('--- Сырые данные ---');
  logger.info(`Типы мест: ${JSON.stringify(state.types)}`);
  logger.info(`Лимит броней/день: ${state.limit}`);
  logger.info(`Доступные дни: [${state.availableDays.join(', ') || 'нет'}], календарь: ${state.month}/${state.year}`);

  await client.close();

  // Критерий этапа: бот корректно прочитал состояние (днём ожидаемо «дат нет»).
  const ok = state.types !== undefined && state.availableDays !== undefined;
  logger.info(ok ? '✅ Этап 2: состояние рынка прочитано корректно' : '❌ Этап 2: ошибка чтения');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
