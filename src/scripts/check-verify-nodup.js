// UAT (фикс ночи 26.06): приём заявок сервером = успех, ЛК-отставание НЕ вызывает
// повторную подачу (дубли). Запуск: node src/scripts/check-verify-nodup.js
//
// На фейковом клиенте (без сети) проверяет attemptForAccount (быстрый путь, DRY_RUN=false):
//  1. ЛК отстал, потом догнал (0→2): успех, подтверждено 2, отправлено РОВНО 2 (нет дубля).
//  2. ЛК так и показывает 0: всё равно успех (pendingConfirm), отправлено РОВНО 2 (НЕТ повторной подачи).
//  3. Сервер отклонил всё (code=500): success=false, reason=rejected (долбёжка уместна).

process.env.DRY_RUN = 'false';
process.env.SUBMIT_GAP_MIN_MS = '0';
process.env.SUBMIT_GAP_MAX_MS = '0';
process.env.VERIFY_REREAD_MS = '10';
process.env.BOOKINGS_PER_ACCOUNT = '2';

const { attemptForAccount } = await import('../runner.js');
const { config } = await import('../config.js');
const { logger } = await import('../logger.js');

config.site.bookingsPerAccount = 2;

const DATE = '2026-07-15';
const predicted = { day: 15, month: 7, year: 2026, dateStr: DATE };

function accountHtml(count) {
  let rows = '';
  for (let i = 0; i < count; i++) {
    rows += `<tr key="${i + 1}"><td>x</td><td>${DATE}</td><td>Минский Комаровский рынок</td><td>Торговый ряд</td><td><input name="f_ovosh" checked></td></tr>`;
  }
  return `<table id="zajav">${rows}</table>`;
}

// lcSeq — что показывает ЛК при последовательных чтениях; code — ответ create_zajav.
function makeClient({ lcSeq = [2], code = '201' } = {}) {
  let getIdx = 0;
  const calls = { create: 0 };
  return {
    calls,
    cookies: {},
    async get() {
      const c = lcSeq[Math.min(getIdx, lcSeq.length - 1)];
      getIdx++;
      return { status: 200, text: accountHtml(c) };
    },
    async post(path) {
      if (path.includes('create_zajav')) {
        calls.create++;
        return { status: 200, text: JSON.stringify({ code }) };
      }
      return { status: 200, text: '{}' };
    },
    async close() {},
  };
}

function makeCtx(client) {
  return {
    tag: 'nodup',
    client,
    loggedIn: true,
    fields: { n_persn: '1', fam: 'Иванов', name: 'Иван', otc: 'И', is_login: '1', type_person: 'fiz' },
    defaultType: 2,
    predicted,
    targetMs: Date.now(),
  };
}

let ok = true;
const check = (name, cond, extra = '') => {
  logger.info(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  ok = ok && cond;
};

async function main() {
  // --- 1: ЛК отстал, потом догнал ---
  const c1 = makeClient({ lcSeq: [0, 2] });
  const r1 = await attemptForAccount(makeCtx(c1), 1);
  check('ЛК 0→2: успех, подтверждено 2, отправлено ровно 2 (нет дубля)',
    r1.success === true && r1.count === 2 && c1.calls.create === 2,
    `success=${r1.success}, count=${r1.count}, отправлено=${c1.calls.create}`);

  // --- 2: ЛК так и показывает 0 ---
  const c2 = makeClient({ lcSeq: [0] });
  const r2 = await attemptForAccount(makeCtx(c2), 1);
  check('ЛК остался 0: успех + pendingConfirm, отправлено ровно 2 (НЕТ повторной подачи)',
    r2.success === true && r2.pendingConfirm === true && c2.calls.create === 2,
    `success=${r2.success}, pendingConfirm=${r2.pendingConfirm}, отправлено=${c2.calls.create}`);

  // --- 3: сервер отклонил всё ---
  const c3 = makeClient({ lcSeq: [0], code: '500' });
  const r3 = await attemptForAccount(makeCtx(c3), 1);
  check('сервер отклонил: success=false, reason=rejected (долбёжка уместна)',
    r3.success === false && r3.reason === 'rejected',
    `success=${r3.success}, reason=${r3.reason}`);

  logger.info(ok ? '✅ Фикс 26.06: приём = успех, ЛК-лаг не плодит дубли' : '❌ Фикс 26.06: есть проблемы');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  logger.error(`Ошибка: ${e.stack || e.message}`);
  process.exit(1);
});
