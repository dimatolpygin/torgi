// UAT этап 12: оптимизация скорости подачи.
// Запуск: node src/scripts/check-speed.js
//
// На фейковом клиенте (без сети и Redis) проверяет:
//  1. С прогревом первый выстрел (00:00) НЕ читает рынок/форму — уходит только подача
//     (в dry-run реального POST нет, но главное: нулевая предварительная работа в 00:00).
//  2. Без прогрева идёт полный путь с чтением рынка (фолбэк/долбёжка сохранены).
//  3. При пустом календаре полный путь возвращает no_date («дата ещё не открылась»).
import { attemptForAccount } from '../runner.js';
import { logger } from '../logger.js';

// Фейковый SiteClient: считает запросы по путям, отдаёт правдоподобные ответы.
function makeFakeClient({ emptyCalendar = false } = {}) {
  const calls = [];
  const selects =
    '<select name="month"><option value="7" selected>07</option></select>' +
    '<select name="year"><option value="2026" selected>2026</option></select>';
  const calHtml = (emptyCalendar ? '<td class="coolday">15</td>' : '<td class="coolday ic_day">15</td>') + selects;
  return {
    calls,
    cookies: {},
    async get(path) {
      calls.push(`GET ${path}`);
      return { status: 200, text: '<input name="n_persn" value="123"><input name="fam" value="Иванов"><input name="is_login" value="1">' };
    },
    async post(path) {
      calls.push(`POST ${path}`);
      if (path.includes('type_mest')) return { status: 200, text: JSON.stringify({ KVO_TORG_MEST: 5 }) };
      if (path.includes('limit_mest')) return { status: 200, text: JSON.stringify({ REZERV_LIMIT: 2 }) };
      if (path.includes('calend')) return { status: 200, text: JSON.stringify({ answer: calHtml }) };
      if (path.includes('create_zajav')) return { status: 200, text: JSON.stringify({ code: '201' }) };
      return { status: 200, text: '{}' };
    },
    async close() {},
  };
}

const predicted = { day: 15, month: 7, year: 2026, dateStr: '2026-07-15' };

async function main() {
  let allOk = true;

  // --- Тест 1: быстрый путь (прогрет) — в 00:00 нет чтения рынка/формы ---
  logger.info('--- Тест 1: быстрый путь с прогревом (00:00 = только подача) ---');
  const fast = makeFakeClient();
  const ctxFast = {
    tag: 'speed',
    client: fast,
    loggedIn: true,
    fields: { n_persn: '123', fam: 'Иванов', name: 'Иван', otc: 'И', is_login: '1', type_person: 'fiz' },
    defaultType: 2,
    predicted,
    targetMs: Date.now(),
  };
  const r1 = await attemptForAccount(ctxFast, 1);
  const preReads = fast.calls.filter((c) => /type_mest|limit_mest|calend|reg\/fiz/.test(c));
  const fastOk = r1.success && r1.date === predicted.dateStr && preReads.length === 0;
  logger.info(`Запросы в 00:00: [${fast.calls.join(', ') || 'нет'}]`);
  logger.info(`Предварительных чтений рынка/формы: ${preReads.length} (ожидалось 0) — ${fastOk ? '✅' : '❌'}`);
  allOk = allOk && fastOk;

  // --- Тест 2: полный путь (нет прогрева) — читает рынок ---
  logger.info('--- Тест 2: без прогрева — полный путь с чтением рынка (фолбэк) ---');
  const full = makeFakeClient();
  const ctxFull = { tag: 'speed', client: full, loggedIn: true }; // без fields/predicted
  const r2 = await attemptForAccount(ctxFull, 1);
  const readMarket = full.calls.some((c) => c.includes('calend'));
  const fullOk = r2.success && readMarket;
  logger.info(`Запросы: [${full.calls.join(', ')}]`);
  logger.info(`Календарь прочитан: ${readMarket ? 'да' : 'нет'} — ${fullOk ? '✅' : '❌'}`);
  allOk = allOk && fullOk;

  // --- Тест 3: пустой календарь → no_date («дата не открылась») ---
  logger.info('--- Тест 3: пустой календарь → no_date ---');
  const empty = makeFakeClient({ emptyCalendar: true });
  const ctxEmpty = { tag: 'speed', client: empty, loggedIn: true };
  const r3 = await attemptForAccount(ctxEmpty, 1);
  const noDateOk = !r3.success && r3.reason === 'no_date';
  logger.info(`Результат: success=${r3.success}, reason=${r3.reason} — ${noDateOk ? '✅' : '❌'}`);
  allOk = allOk && noDateOk;

  logger.info(
    allOk
      ? '✅ Этап 12: в 00:00 уходит только подача, фолбэк/долбёжка с чтением рынка сохранены'
      : '❌ Этап 12: есть проблемы',
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
