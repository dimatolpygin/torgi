// UAT этапа 14 (пункт 3): обработка «нет даты» и сетевых сбоев без падения.
// Детерминированно, через фейк-клиент (реальный сайт не дёргаем).
// Запуск: node src/scripts/check-resilience.js
import { attemptForAccount } from '../runner.js';
import { logger } from '../logger.js';

// Фейк-клиент: отвечает на эндпоинты чтения рынка. mode управляет поведением.
function fakeClient(mode) {
  return {
    async post(path, _data, _opts) {
      if (mode === 'throw') throw new Error('ECONNRESET (имитация сетевого сбоя)');
      if (path.includes('type_mest')) return { text: JSON.stringify({ KVO_TORG_MASH: '0', KVO_TORG_MEST: '1' }) };
      if (path.includes('limit_mest')) return { text: JSON.stringify({ REZERV_LIMIT: '2' }) };
      if (path.includes('calend')) return { text: JSON.stringify({ answer: '<table><td class="coolday">28</td></table>' }) }; // нет ic_day → дат нет
      return { text: '{}' };
    },
    async get() { return { text: '' }; },
    async close() {},
  };
}

// Точно тот же catch, что в orchestrator.runForContext (строки 16-21).
const orchestratorCatch = (e) => ({ tag: 'test', success: false, reason: 'error', error: e });

async function main() {
  let pass = 0, total = 0;

  // 1) «Нет даты»: пустой календарь → reason no_date, без исключения.
  total++;
  const ctxNoDate = { tag: 'test', client: fakeClient('no_date'), loggedIn: true };
  const r1 = await attemptForAccount(ctxNoDate, 1).catch(orchestratorCatch);
  const ok1 = r1.success === false && r1.reason === 'no_date';
  logger.info(`1) нет даты → ${JSON.stringify({ success: r1.success, reason: r1.reason })} ${ok1 ? '✅' : '❌'}`);
  if (ok1) pass++;

  // 2) Сетевой сбой на чтении рынка → ловится оркестраторным catch → reason error, процесс жив.
  total++;
  const ctxThrow = { tag: 'test', client: fakeClient('throw'), loggedIn: true };
  const r2 = await attemptForAccount(ctxThrow, 1).catch(orchestratorCatch);
  const ok2 = r2.success === false && r2.reason === 'error' && r2.error instanceof Error;
  logger.info(`2) сетевой сбой → ${JSON.stringify({ success: r2.success, reason: r2.reason, err: r2.error?.message })} ${ok2 ? '✅' : '❌'}`);
  if (ok2) pass++;

  // 3) Незалогиненный аккаунт → reason not_logged_in (graceful, без падения).
  total++;
  const r3 = await attemptForAccount({ tag: 'test', client: fakeClient('no_date'), loggedIn: false }, 1).catch(orchestratorCatch);
  const ok3 = r3.success === false && r3.reason === 'not_logged_in';
  logger.info(`3) не залогинен → ${JSON.stringify({ success: r3.success, reason: r3.reason })} ${ok3 ? '✅' : '❌'}`);
  if (ok3) pass++;

  logger.info(`--- Итог: ${pass}/${total} ---`);
  logger.info(pass === total ? '✅ Пункт 3: «нет даты» и сетевые сбои обрабатываются без падения' : '❌ Есть провалы');
  process.exit(pass === total ? 0 : 1);
}
main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
