// UAT-скрипт этапа 1: проверка авторизации на сайте.
// Запуск: node src/scripts/check-auth.js
import { login } from '../site/auth.js';
import { getAccounts } from '../accounts.js';
import { logger } from '../logger.js';

async function main() {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    logger.error('Нет аккаунтов в ACCOUNTS (.env). Формат: ACCOUNTS=логин:пароль');
    process.exit(1);
  }

  const { login: loginName, password } = accounts[0];

  logger.info('--- Проверка 1: вход с верными данными ---');
  const ok = await login(loginName, password);
  await ok.client.close();

  logger.info('--- Проверка 2: вход с заведомо неверным паролем ---');
  const bad = await login(loginName, password + '_wrong');
  await bad.client.close();

  logger.info('--- Итог ---');
  logger.info(`Верные данные → вход: ${ok.loggedIn ? 'да' : 'нет'}, ФИО: ${ok.fio || '—'}`);
  logger.info(`Неверный пароль → вход: ${bad.loggedIn ? 'да (ОШИБКА!)' : 'нет (ожидаемо)'}`);

  const pass = ok.loggedIn && !bad.loggedIn;
  logger.info(pass ? '✅ Этап 1: критерии сошлись' : '❌ Этап 1: что-то не так');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
