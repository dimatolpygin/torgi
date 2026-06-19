// UAT-скрипт этапа 6: параллельная работа двух аккаунтов с изоляцией сессий.
// Запуск: node src/scripts/check-multi.js
// Данных мужа пока нет, поэтому для демонстрации изоляции используем второй
// «аккаунт» = тот же логин с неверным паролем: один войдёт, другой нет —
// видно, что сессии независимы и не путаются.
import { prepareAll, attemptAll, closeAll } from '../runner.js';
import { getAccounts } from '../accounts.js';
import { logger } from '../logger.js';

async function main() {
  const base = getAccounts()[0];
  if (!base) {
    logger.error('Нет аккаунтов в ACCOUNTS');
    process.exit(1);
  }

  // Два независимых аккаунта для демонстрации параллельности и изоляции
  const accounts = [
    { login: base.login, password: base.password }, // войдёт
    { login: base.login, password: base.password + '_wrong' }, // не войдёт
  ];

  logger.info(`--- Параллельная подготовка ${accounts.length} аккаунтов ---`);
  const t0 = Date.now();
  const contexts = await prepareAll(accounts);
  logger.info(`Подготовка заняла ${Date.now() - t0} мс (параллельно)`);

  logger.info('--- Параллельная попытка подачи по всем аккаунтам ---');
  const results = await attemptAll(contexts, 1);

  logger.info('--- Итоги по аккаунтам ---');
  results.forEach((r, i) => {
    logger.info(`Аккаунт #${i + 1} [${r.tag}]: success=${r.success}, причина=${r.reason || (r.dryRun ? 'dry-run ok' : '—')}`);
  });

  await closeAll(contexts);

  // Изоляция: первый аккаунт залогинен (своя сессия), второй — нет.
  const isolated = contexts[0].loggedIn === true && contexts[1].loggedIn === false;
  logger.info(`Изоляция сессий: первый вошёл=${contexts[0].loggedIn}, второй вошёл=${contexts[1].loggedIn} — ${isolated ? '✅' : '❌'}`);

  const ok = isolated && results.length === 2;
  logger.info(ok ? '✅ Этап 6: два аккаунта ведутся параллельно, сессии изолированы' : '❌ Этап 6: проблема');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
