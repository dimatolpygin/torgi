// UAT этап 20: безопасный фолбэк упреждения выстрела (send-ahead).
// Запуск: node src/scripts/check-sendahead.js
//
// Детерминированно (фейк-клиент, без сети/Redis) проверяет:
//  1. Ранний выстрел отклонён (no_date) + упреждение включено + не прошли 00:00 →
//     бот ЖДЁТ истинную полночь и повторяет подачу (2 вызова create_zajav, флаг фолбэка).
//  2. Упреждение выключено (SEND_AHEAD_MS=0) → фолбэка нет (1 вызов, без ожидания).
//  3. Истинная полночь уже прошла (окно закрыто) → фолбэка нет (1 вызов).
//
// Оба выстрела в фейке возвращают no_date, поэтому success-хвост (Redis/ЛК) не
// задействуется — тест изолирован на логике фолбэка.
process.env.DRY_RUN = 'false';
process.env.BOOKINGS_PER_ACCOUNT = '1';

const { attemptForAccount } = await import('../runner.js');
const { logger } = await import('../logger.js');

// Фейк-клиент: create_zajav всегда отвечает no_date (отклонение). Считает вызовы.
function makeRejectClient() {
  const calls = [];
  return {
    calls,
    async post(path) {
      calls.push(path);
      return { status: 500, text: JSON.stringify({ code: 500, arr_date: 'no_date' }) };
    },
    async get(path) {
      calls.push(`GET ${path}`);
      return { status: 200, text: '' };
    },
  };
}

function baseCtx(client, { sendAheadMs, trueTargetMs }) {
  return {
    tag: 'test',
    client,
    loggedIn: true,
    fields: { n_persn: '1', fam: 'Тест', name: 'Т', otc: 'Т', is_login: '1' },
    defaultType: 2,
    predicted: { day: 21, month: 7, year: 2026, dateStr: '2026-07-21' },
    targetMs: Date.now(),
    trueTargetMs,
    sendAheadMs,
  };
}

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { logger.info(`✅ ${msg}`); pass++; } else { logger.error(`❌ ${msg}`); fail++; } };

// 1. Упреждение вкл, отклонение, полночь через 80 мс → фолбэк: ждём и повторяем.
{
  const client = makeRejectClient();
  const trueTargetMs = Date.now() + 80;
  const t0 = Date.now();
  const r = await attemptForAccount(baseCtx(client, { sendAheadMs: 1, trueTargetMs }), 1);
  const waited = Date.now() - t0;
  const posts = client.calls.filter((c) => c === '/rinki/minsk/create_zajav/').length;
  ok(posts === 2, `фолбэк: 2 вызова create_zajav (ранний + повтор в 00:00), факт ${posts}`);
  ok(r.sendAheadFallback === true, 'фолбэк: флаг sendAheadFallback выставлен');
  ok(waited >= 70, `фолбэк: дождались истинной полуночи (~${waited} мс, ждали до +80)`);
  ok(r.success === false && r.reason === 'rejected', 'фолбэк: итог всё ещё rejected (оба выстрела no_date)');
}

// 2. Упреждение выключено → фолбэка нет.
{
  const client = makeRejectClient();
  const r = await attemptForAccount(baseCtx(client, { sendAheadMs: 0, trueTargetMs: Date.now() + 80 }), 1);
  const posts = client.calls.filter((c) => c === '/rinki/minsk/create_zajav/').length;
  ok(posts === 1, `упреждение выкл: 1 вызов create_zajav (без повтора), факт ${posts}`);
  ok(!r.sendAheadFallback, 'упреждение выкл: флаг фолбэка не выставлен');
}

// 3. Истинная полночь уже прошла (окно фолбэка закрыто) → повтора нет.
{
  const client = makeRejectClient();
  const r = await attemptForAccount(baseCtx(client, { sendAheadMs: 1, trueTargetMs: Date.now() - 1000 }), 1);
  const posts = client.calls.filter((c) => c === '/rinki/minsk/create_zajav/').length;
  ok(posts === 1, `дедлайн прошёл: 1 вызов create_zajav (фолбэк не сработал), факт ${posts}`);
  ok(!r.sendAheadFallback, 'дедлайн прошёл: флаг фолбэка не выставлен');
}

logger.info(`\nИтог: ${pass} ✅ / ${fail} ❌`);
if (fail === 0) logger.info('✅ Этап 20: безопасный фолбэк упреждения работает (ждём 00:00 и повторяем; выкл/дедлайн — без повтора)');
process.exit(fail === 0 ? 0 : 1);
