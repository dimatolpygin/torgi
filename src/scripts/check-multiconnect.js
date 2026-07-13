// UAT этап 21: мультиконнект — гоночный залп места №1 по K сокетам + гашение дублей.
// Запуск: node src/scripts/check-multiconnect.js
//
// Детерминированно (фейк-сервер с общим состоянием броней, без сети/Redis) проверяет:
//  1. Залп идёт по всем K сокетам параллельно; победитель = самый быстрый принятый.
//  2. Лишние приёмы (сервер НЕ срезал на лимите) гасятся отменой до 1 места №1;
//     место №2 добирается маскированным выстрелом → в ЛК ровно нужное число.
//  3. Сервер отклонил все K (no_date) → success=false, reason=rejected, отмен нет.
process.env.DRY_RUN = 'false';
process.env.MULTICONNECT_K = '3';
process.env.BOOKINGS_PER_ACCOUNT = '2';
process.env.SUBMIT_GAP_MIN_MS = '0';
process.env.SUBMIT_GAP_MAX_MS = '0'; // без реальной паузы, чтобы тест был быстрым

const { attemptForAccount } = await import('../runner.js');
const { logger } = await import('../logger.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Общий «сервер»: брони живут в state, все сокеты одной сессии видят их (как в реальности).
function makeServer({ reject = false } = {}) {
  return { bookings: [], nextKey: 90000, idUser: '777', reject, createCalls: 0, delCalls: 0 };
}

function renderAccount(state) {
  const rows = state.bookings
    .map(
      (b) =>
        `<tr key="${b.key}"><td>x</td><td>${b.date}</td><td>Комаровский рынок</td><td>Торговый ряд</td><td><input name="f_ovosh" checked></td></tr>`,
    )
    .join('');
  return `<input name="id_user" value="${state.idUser}"><table id="zajav">${rows}</table>`;
}

// Фейк-клиент поверх общего state. createDelayMs — искусственная задержка сокета
// (чтобы проверить выбор самого быстрого победителя).
function makeClient(state, dateStr, { createDelayMs = 0 } = {}) {
  return {
    cookies: new Map([['gorodid', 'x']]),
    async post(path, body) {
      if (path.includes('create_zajav')) {
        if (createDelayMs) await sleep(createDelayMs);
        state.createCalls++;
        if (state.reject) return { status: 500, text: JSON.stringify({ code: 500, arr_date: 'no_date' }) };
        state.bookings.push({ key: String(state.nextKey++), date: dateStr });
        return { status: 201, text: JSON.stringify({ code: 201 }) };
      }
      if (path.includes('account') && body?.ACTION === 'del') {
        state.delCalls++;
        const keys = Object.values(JSON.parse(body.LIST));
        state.bookings = state.bookings.filter((b) => !keys.includes(b.key));
        return { status: 200, text: JSON.stringify({ code: 200 }) };
      }
      return { status: 200, text: '' };
    },
    async get(path) {
      if (path.includes('account')) return { status: 200, text: renderAccount(state) };
      return { status: 200, text: '' };
    },
    async close() {},
  };
}

function makeCtx(state, dateStr) {
  // Сокет #2 самый быстрый (delay 5) → он должен победить; #0 медленный (30).
  const delays = [30, 18, 5];
  const clients = delays.map((d) => makeClient(state, dateStr, { createDelayMs: d }));
  return {
    tag: 'test',
    client: clients[0],
    clients,
    loggedIn: true,
    fields: { n_persn: '1', fam: 'Т', name: 'Т', otc: 'Т', is_login: '1' },
    defaultType: 2,
    predicted: { day: 21, month: 7, year: 2026, dateStr },
    targetMs: Date.now(),
  };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { logger.info(`✅ ${m}`); pass++; } else { logger.error(`❌ ${m}`); fail++; } };

const DATE = '2026-07-21';

// 1. Сервер принимает все (лимит не срезал) → залп 3, гасим 2, место №2 добираем → ЛК=2.
{
  const state = makeServer();
  const r = await attemptForAccount(makeCtx(state, DATE), 1);
  ok(state.createCalls === 3 + 1, `залп по 3 сокетам + добор места №2 = 4 create_zajav (факт ${state.createCalls})`);
  ok(r.multiconnect?.k === 3, `в отчёте k=3 (факт ${r.multiconnect?.k})`);
  ok(r.multiconnect?.acceptedCount === 3, `принято 3 в залпе (факт ${r.multiconnect?.acceptedCount})`);
  ok(r.multiconnect?.winnerSocket === 2, `победил самый быстрый сокет #2 (факт #${r.multiconnect?.winnerSocket})`);
  ok(r.multiconnect?.cancelled === 2, `отменено 2 дубля залпа (факт ${r.multiconnect?.cancelled})`);
  ok(state.bookings.length === 2, `в ЛК ровно 2 места, без перебора (факт ${state.bookings.length})`);
  ok(r.success === true && r.count === 2, `итог success, 2 места (success=${r.success}, count=${r.count})`);
}

// 2. Сервер отклонил все → success=false, reason=rejected, отмен нет.
{
  const state = makeServer({ reject: true });
  const r = await attemptForAccount(makeCtx(state, DATE), 1);
  ok(r.success === false && r.reason === 'rejected', `все отклонены → success=false/rejected (${r.success}/${r.reason})`);
  ok(state.delCalls === 0 && r.multiconnect?.acceptedCount === 0, 'отмен нет, принято 0');
}

logger.info(`\nИтог: ${pass} ✅ / ${fail} ❌`);
if (fail === 0) logger.info('✅ Этап 21: залп по K, победитель — быстрейший, дубли гасятся, в ЛК ровно нужное');
process.exit(fail === 0 ? 0 : 1);
