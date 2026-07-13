// UAT этап 23: развязка выстрелов — залип POST одного места НЕ сдвигает метку другого.
// Запуск: node src/scripts/check-stage23.js
//
// Баг 12.07: 2-я заявка ушла на +8 с вместо +1 с. Причина (доказана): обе заявки шли
// на ОДНОМ сокете последовательными await — метка 2-й считалась ПОСЛЕ round-trip 1-й,
// поэтому залип POST #1 (медленный ответ Apache в полуночный наплыв) впитывался в +8 с.
// Гипотеза ROADMAP (блокировка event-loop парсингом parseBookings) опровергнута: парсинг
// даже 2000 броней = ~10 мс и идёт ПОСЛЕ обеих заявок.
//
// Детерминированно (фейк-сервер, без сети/Redis) проверяет:
//  A. ВОСПРОИЗВЕДЕНИЕ бага: один сокет, N=2, gap=0 — POST #1 «залип» на DELAY мс →
//     метка 2-й заявки впитывает задержку (submitTimesMs[1] ≈ DELAY). Это старое поведение.
//  B. ФИКС: N сокетов (по сокету на место), залп параллельно — метка 2-й заявки НЕ ждёт
//     ответа 1-й (submitTimesMs[1] ≈ 0), при этом залип виден в телеметрии (maxResponseMs≈DELAY).
process.env.DRY_RUN = 'false';
process.env.MULTICONNECT_K = '1'; // мультиконнект выключен (боевой конфиг)
process.env.BOOKINGS_PER_ACCOUNT = '2';
process.env.SUBMIT_GAP_MIN_MS = '0';
process.env.SUBMIT_GAP_MAX_MS = '0'; // обе в гонку (этап 22)

const { attemptForAccount } = await import('../runner.js');
const { logger } = await import('../logger.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATE = '2026-07-21';
const DELAY = 500; // стенд-ин для «+8 с»: залип ответа POST #1, чтобы тест шёл быстро

function makeServer() {
  return { bookings: [], nextKey: 90000, idUser: '777', createCalls: 0, delCalls: 0 };
}
function renderAccount(state) {
  const rows = state.bookings
    .map((b) => `<tr key="${b.key}"><td>x</td><td>${b.date}</td><td>Комаровский рынок</td><td>Торговый ряд</td><td><input name="f_ovosh" checked></td></tr>`)
    .join('');
  return `<input name="id_user" value="${state.idUser}"><table id="zajav">${rows}</table>`;
}
// createDelayMs — искусственный залип ответа create_zajav на этом сокете.
function makeClient(state, { createDelayMs = 0 } = {}) {
  return {
    cookies: new Map([['gorodid', 'x']]),
    async post(path, body) {
      if (path.includes('create_zajav')) {
        if (createDelayMs) await sleep(createDelayMs);
        state.createCalls++;
        state.bookings.push({ key: String(state.nextKey++), date: DATE });
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
function baseCtx(state, clients) {
  return {
    tag: 'test',
    client: clients[0],
    clients,
    loggedIn: true,
    fields: { n_persn: '1', fam: 'Т', name: 'Т', otc: 'Т', is_login: '1' },
    defaultType: 2,
    predicted: { day: 21, month: 7, year: 2026, dateStr: DATE },
    targetMs: Date.now(),
  };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { logger.info(`✅ ${m}`); pass++; } else { logger.error(`❌ ${m}`); fail++; } };

// A. Воспроизведение бага: ОДИН сокет (clients.length < N) → последовательный путь.
//    POST #1 залипает на DELAY → метка 2-й заявки впитывает залип.
{
  const state = makeServer();
  const c = makeClient(state, { createDelayMs: DELAY });
  const ctx = baseCtx(state, [c]); // один сокет → развязка недоступна, старый путь
  const r = await attemptForAccount(ctx, 1);
  const t2 = r.submitTimesMs?.[1] ?? -1;
  logger.info(`A: submitTimesMs=${JSON.stringify(r.submitTimesMs)} (залип POST #1 = ${DELAY} мс)`);
  ok(t2 >= DELAY - 50, `ВОСПРОИЗВЕДЕНО: на одном сокете метка 2-й заявки впитывает залип 1-й (${t2} мс ≥ ~${DELAY})`);
  ok(r.success === true && state.createCalls === 2, `обе заявки поданы (create=${state.createCalls})`);
}

// B. Фикс: ДВА сокета (по сокету на место) → параллельный залп. Сокет #0 (место №1)
//    залип на DELAY, сокет #1 (место №2) быстрый. Метка 2-й НЕ ждёт ответа 1-й.
{
  const state = makeServer();
  const c0 = makeClient(state, { createDelayMs: DELAY }); // место №1 «залипло»
  const c1 = makeClient(state, { createDelayMs: 0 }); // место №2 быстрое
  const ctx = baseCtx(state, [c0, c1]);
  const r = await attemptForAccount(ctx, 1);
  const t = r.submitTimesMs || [];
  logger.info(`B: submitTimesMs=${JSON.stringify(t)}, maxResponseMs=${r.maxResponseMs}`);
  ok(Math.max(...t) < 100, `РАЗВЯЗАНО: обе метки отправки малы, 2-я не ждёт round-trip 1-й (max ${Math.max(...t)} мс < 100)`);
  ok((r.maxResponseMs ?? 0) >= DELAY - 50, `залип ВИДЕН в телеметрии: maxResponseMs=${r.maxResponseMs} мс ≈ ${DELAY}`);
  ok(r.success === true && r.count === 2, `итог success, 2 места (success=${r.success}, count=${r.count})`);
  ok(state.bookings.length === 2 && state.delCalls === 0, `в ЛК ровно 2 места, без перебора/отмен (факт ${state.bookings.length}, del=${state.delCalls})`);
}

logger.info(`\nИтог: ${pass} ✅ / ${fail} ❌`);
if (fail === 0) logger.info('✅ Этап 23: залип POST одного места не сдвигает метку другого; залип виден в телеметрии');
process.exit(fail === 0 ? 0 : 1);
