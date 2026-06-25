// UAT этап 18: персональный тайминг жене/мужу + время 2-й заявки разработчику.
// Запуск: node src/scripts/check-timing-roles.js
//
// Без сети/Telegram проверяет:
//  1. accountRole() матчит логин (меняется по дням) по стабильной подстройке → роль.
//  2. timingNotice (dev) показывает ОБЕ заявки (1-ю и 2-ю) по ОБОИМ аккаунтам.
//  3. accountTimingNotice (жена/муж) показывает время их кабинета: 1-я и 2-я заявка.
//  4. Маршрутизация (как в orchestrator): жене уходит её кабинет, мужу — его, dev — нет
//     (он получает общий отчёт), неуспешный кабинет — не уходит.

process.env.ACCOUNT_ROLES = '4131195:wife,3080391:husband';

const { accountRole } = await import('../config.js');
const { timingNotice, accountTimingNotice } = await import('../messages.js');
const { logger } = await import('../logger.js');

// Логины как в бою (меняются по дням — матч по стабильной части до 'c').
const wifeR = { tag: '4131195c020pb4', fio: 'Стемпковская А.В.', success: true, date: '2026-07-02', count: 2, submitTimesMs: [1, 2001] };
const husbR = { tag: '3080391c020pb8', fio: 'Петрусевич В.Г.', success: true, date: '2026-07-02', count: 2, submitTimesMs: [3, 2003] };
const results = [wifeR, husbR];

let ok = true;
const check = (name, cond, extra = '') => {
  logger.info(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  ok = ok && cond;
};

// --- 1: accountRole ---
check('accountRole(жена) = wife', accountRole(wifeR.tag) === 'wife', accountRole(wifeR.tag));
check('accountRole(муж) = husband', accountRole(husbR.tag) === 'husband', accountRole(husbR.tag));
check('accountRole(чужой) = null', accountRole('9999999c001xx0') === null);

// --- 2: dev timingNotice — обе заявки по обоим аккаунтам ---
const dev = timingNotice({ drift: 0, results, dryRun: false });
logger.info('--- timingNotice (dev) ---\n' + dev);
const devBoth =
  dev.includes('Стемпковская') && dev.includes('Петрусевич') &&
  (dev.match(/1-я заявка/g) || []).length === 2 &&
  (dev.match(/2-я заявка/g) || []).length === 2;
check('dev: 1-я и 2-я заявка по обоим аккаунтам', devBoth);

// --- 3: accountTimingNotice — кабинет жены ---
const wifeMsg = accountTimingNotice(wifeR, { date: '2026-07-02', dryRun: false });
logger.info('--- accountTimingNotice (жена) ---\n' + wifeMsg);
const wifeOk =
  wifeMsg.includes('Стемпковская') && !wifeMsg.includes('Петрусевич') &&
  wifeMsg.includes('1-я заявка') && wifeMsg.includes('2-я заявка') && wifeMsg.includes('после первой');
check('жена: свой кабинет, 1-я и 2-я заявка, разрыв указан', wifeOk);

// --- 4: маршрутизация (повтор логики orchestrator) ---
const sent = [];
const notifier = { notifyRole: async (roles, text) => sent.push({ roles, head: text.split('\n')[0] }) };
const failBad = { tag: '3080391c020pb8', fio: 'Петрусевич В.Г.', success: false, reason: 'rejected' };
for (const r of [wifeR, husbR, failBad]) {
  if (!r.success) continue;
  const role = accountRole(r.tag);
  if (!role || role === 'dev') continue;
  await notifier.notifyRole([role], accountTimingNotice(r, { date: '2026-07-02' }));
}
const routeOk =
  sent.length === 2 &&
  sent.some((s) => s.roles[0] === 'wife') &&
  sent.some((s) => s.roles[0] === 'husband');
check('маршрутизация: 2 адресата (wife+husband), неуспех не ушёл', routeOk, `отправлено ${sent.length}`);

logger.info(ok ? '✅ Этап 18: персональный тайминг и маршрутизация корректны' : '❌ Этап 18: есть проблемы');
process.exit(ok ? 0 : 1);
