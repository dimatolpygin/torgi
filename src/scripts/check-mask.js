// UAT этап 17: разнос второй заявки по времени (маскировка).
// Запуск: node src/scripts/check-mask.js
//
// На фейковом клиенте (без сети и Redis, dry-run) проверяет:
//  1. При BOOKINGS_PER_ACCOUNT=2 собирается РОВНО 2 заявки; 2-я уходит после
//     рандомной паузы из [SUBMIT_GAP_MIN_MS, SUBMIT_GAP_MAX_MS] — измеряем по
//     времени всей подачи (1-я и get мгновенны в dry-run, значит elapsed ≈ пауза).
//  2. Разрыв рандомизирован: по нескольким прогонам паузы не одинаковы (нет фикс. следа).
//  3. При BOOKINGS_PER_ACCOUNT=1 паузы нет (elapsed ≈ 0) — заявка одна.
//
// Диапазон для теста занижен (60–200 мс), чтобы прогон был быстрым; в бою — 2000–8000.

// env читается config.js при импорте — выставляем ДО динамического import.
const GAP_MIN = 60;
const GAP_MAX = 200;
process.env.SUBMIT_GAP_MIN_MS = String(GAP_MIN);
process.env.SUBMIT_GAP_MAX_MS = String(GAP_MAX);
process.env.DRY_RUN = 'true'; // без реальных POST и без verifyBooking (getBookings)

const { attemptForAccount } = await import('../runner.js');
const { config } = await import('../config.js');
const { logger } = await import('../logger.js');

const predicted = { day: 15, month: 7, year: 2026, dateStr: '2026-07-15' };

function makeFakeClient() {
  return {
    cookies: {},
    async get() {
      return { status: 200, text: '<input name="is_login" value="1">' };
    },
    async post() {
      return { status: 200, text: JSON.stringify({ code: '201' }) };
    },
    async close() {},
  };
}

function makeCtx(client) {
  return {
    tag: 'mask',
    client,
    loggedIn: true,
    fields: { n_persn: '1', fam: 'Иванов', name: 'Иван', otc: 'И', is_login: '1', type_person: 'fiz' },
    defaultType: 2,
    predicted,
    targetMs: Date.now(),
  };
}

// Один прогон: возвращает число заявок и время всей подачи (≈ разрыв при n=2).
async function runOnce(perAccount) {
  config.site.bookingsPerAccount = perAccount;
  const t0 = Date.now();
  const r = await attemptForAccount(makeCtx(makeFakeClient()), 1);
  return { count: r.count, elapsed: Date.now() - t0 };
}

async function main() {
  let allOk = true;

  // --- Тест 1: 2 места — ровно 2 заявки, 2-я после паузы в диапазоне ---
  logger.info('--- Тест 1: BOOKINGS_PER_ACCOUNT=2 — 1 заявка сразу, 2-я с разрывом ---');
  const r1 = await runOnce(2);
  // верхняя граница с запасом на накладные расходы планировщика setTimeout
  const inRange = r1.elapsed >= GAP_MIN && r1.elapsed <= GAP_MAX + 80;
  const twoOk = r1.count === 2 && inRange;
  logger.info(`Заявок: ${r1.count} (ожидалось 2); разрыв до 2-й: ~${r1.elapsed} мс (диапазон ${GAP_MIN}–${GAP_MAX}) — ${twoOk ? '✅' : '❌'}`);
  allOk = allOk && twoOk;

  // --- Тест 2: рандомизация — паузы по прогонам не одинаковы ---
  logger.info('--- Тест 2: разрыв рандомизирован (нет фикс. следа) ---');
  const samples = [r1.elapsed];
  for (let i = 0; i < 5; i++) samples.push((await runOnce(2)).elapsed);
  const allInRange = samples.every((g) => g >= GAP_MIN && g <= GAP_MAX + 80);
  const varied = new Set(samples).size > 1; // при честном рандоме совпадение всех 6 невозможно
  const randOk = allInRange && varied;
  logger.info(`Замеры пауз: [${samples.join(', ')}] мс; в диапазоне: ${allInRange ? 'да' : 'нет'}, различаются: ${varied ? 'да' : 'нет'} — ${randOk ? '✅' : '❌'}`);
  allOk = allOk && randOk;

  // --- Тест 3: 1 место — паузы нет, заявка одна ---
  logger.info('--- Тест 3: BOOKINGS_PER_ACCOUNT=1 — паузы нет ---');
  const r3 = await runOnce(1);
  const oneOk = r3.count === 1 && r3.elapsed < GAP_MIN;
  logger.info(`Заявок: ${r3.count} (ожидалось 1), время подачи: ~${r3.elapsed} мс (без разрыва) — ${oneOk ? '✅' : '❌'}`);
  allOk = allOk && oneOk;

  logger.info(
    allOk
      ? '✅ Этап 17: 1-я заявка сразу, 2-я с рандомным разрывом по аккаунту; при 1 месте разрыва нет'
      : '❌ Этап 17: есть проблемы',
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
