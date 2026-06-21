// UAT этапа 15: 2-аккаунтная оркестрация ночи в DRY_RUN, без Telegram и без броней.
// Проверяет параллельные вход/прогрев/выстрел и два результата по обоим аккаунтам.
// Запуск: ACCOUNTS="login1:pass1,login2:pass2" node src/scripts/check-multi-e2e.js
import { runNightly } from '../orchestrator.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Заглушка нотификатора: логирует вместо отправки в Telegram (никаких внешних эффектов).
const stubNotifier = {
  alert: async (t) => logger.warn(`[NOTIFY-STUB alert] ${String(t).split('\n')[0]}`),
  notifyRunResult: async (results, { date } = {}) => {
    logger.info(`[NOTIFY-STUB] дата ${date}: ` + results.map((r) => `${r.fio || r.tag}=${r.success ? 'OK' : 'FAIL:' + r.reason}`).join(' · '));
  },
};

async function main() {
  const accounts = getAccounts();
  if (accounts.length < 2) { logger.error(`Нужно 2 аккаунта в ACCOUNTS, сейчас ${accounts.length}`); process.exit(1); }
  if (!config.timing.dryRun) { logger.error('DRY_RUN должен быть true — это тест без реальных броней'); process.exit(1); }

  logger.info(`2-аккаунтный E2E (DRY_RUN), аккаунтов: ${accounts.length}`);
  const targetMs = Date.now() + 14_000; // имитация полуночи через 14с
  const results = await runNightly(stubNotifier, accounts, { targetMs, leadSeconds: 9 });

  logger.info('--- Результаты по аккаунтам ---');
  results.forEach((r) => logger.info(`  ${r.fio || r.tag}: success=${r.success}, reason=${r.reason || '—'}, date=${r.date || '—'}, dryRun=${r.dryRun || false}`));

  const tags = new Set(results.map((r) => r.tag));
  const ok = results.length === accounts.length && tags.size === accounts.length && results.every((r) => r.success);
  logger.info(ok
    ? '✅ Оба аккаунта отработали параллельно, изолированно, по одному результату на каждый'
    : '❌ Что-то не так — см. результаты выше');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
