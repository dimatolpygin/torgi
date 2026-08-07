// UAT-скрипт этапов ext-1…ext-3: каркас расширения Chrome, считывание токена проверки
// и сборка заявки. Офлайн: манифест, синтаксис файлов, логика библиотек (минское время,
// кабинет, годность токена) и побайтовая сверка payload create_zajav с ботом.
// В сеть не ходит, Chrome не нужен.
// Запуск: node src/scripts/check-ext.js
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { buildCreateZajavPayload } from '../site/order.js';
import { logger } from '../logger.js';

const EXT = path.resolve('ext');
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) logger.info(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failed += 1;
    logger.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Загрузка библиотеки расширения в изолированный контекст. Файлы намеренно написаны
// без import/export (их подключает и content script, и popup), поэтому берём их через vm
// и забираем мост module.exports в конце файла.
function loadLib(rel, extraGlobals = {}) {
  const code = fs.readFileSync(path.join(EXT, rel), 'utf8');
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Intl, Date, JSON, URLSearchParams, Number, console, ...extraGlobals });
  return mod.exports;
}

// --- Манифест ---------------------------------------------------------------
logger.info('--- Манифест ---');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

check('manifest_version = 3', manifest.manifest_version === 3, String(manifest.manifest_version));
check('есть имя и версия', !!manifest.name && /^\d+\.\d+\.\d+$/.test(manifest.version), `${manifest.name} ${manifest.version}`);
check(
  'права только на сам сайт',
  JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://gorod.it-minsk.by/*']),
  JSON.stringify(manifest.host_permissions),
);
check(
  'никаких дополнительных permissions',
  !manifest.permissions || manifest.permissions.length === 0,
  JSON.stringify(manifest.permissions || []),
);
check('нет фонового скрипта (не нужен)', !manifest.background);

const cs = (manifest.content_scripts || [])[0];
check(
  'content script только на странице подачи',
  !!cs && JSON.stringify(cs.matches) === JSON.stringify(['https://gorod.it-minsk.by/rinki/minsk/reg/*']),
  cs ? JSON.stringify(cs.matches) : 'нет content_scripts',
);
check('панель подключена как popup', manifest.action?.default_popup === 'popup.html', manifest.action?.default_popup);

// --- Файлы и синтаксис ------------------------------------------------------
logger.info('--- Файлы и синтаксис ---');
const declared = [...(cs?.js || []), manifest.action?.default_popup].filter(Boolean);
for (const rel of declared) {
  check(`файл из манифеста существует: ${rel}`, fs.existsSync(path.join(EXT, rel)));
}
const extras = ['popup.js', 'popup.css', 'README.md'];
for (const rel of extras) check(`файл на месте: ${rel}`, fs.existsSync(path.join(EXT, rel)));

for (const rel of ['lib/minsk.js', 'lib/account.js', 'lib/guard.js', 'lib/order.js', 'content.js', 'popup.js']) {
  let ok = true;
  let err = '';
  try {
    execFileSync(process.execPath, ['--check', path.join(EXT, rel)], { stdio: 'pipe' });
  } catch (e) {
    ok = false;
    err = String(e.stderr || e.message).split('\n')[1] || '';
  }
  check(`синтаксис ${rel}`, ok, err);
}

const popupHtml = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
for (const src of ['lib/minsk.js', 'lib/account.js', 'lib/guard.js', 'lib/order.js', 'popup.js', 'popup.css']) {
  check(`popup.html подключает ${src}`, popupHtml.includes(src));
}

// Превью (ext/dev/preview.html) — панель без Chrome и без сайта, для разработки и показа.
// Оно рисуется тем же popup.js, поэтому обязано иметь те же id: разъедутся — превью
// начнёт врать, а заметить это будет нечем.
const ids = (html) => [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).sort();
const previewHtml = fs.readFileSync(path.join(EXT, 'dev', 'preview.html'), 'utf8');
const missingInPreview = ids(popupHtml).filter((id) => !ids(previewHtml).includes(id));
check('превью содержит всю разметку панели', missingInPreview.length === 0, `не хватает: ${missingInPreview.join(', ') || '—'}`);
check('превью не попало в манифест', !JSON.stringify(manifest).includes('preview'));

// --- Минское время ----------------------------------------------------------
logger.info('--- Минское время и целевая дата ---');
const minsk = loadLib('lib/minsk.js');

check('смещение Минска = UTC+3', minsk.tzOffsetMs(Date.UTC(2026, 7, 7, 12, 0, 0)) === 3 * 3600 * 1000);
check('формат даты как в боте', minsk.buildDateStr(5, 9, 2026) === '2026-09-05');
check('обратный отсчёт форматируется', minsk.formatCountdown(2 * 3600000 + 13 * 60000 + 7000) === '02:13:07', minsk.formatCountdown(7987000));
check('отрицательный остаток не ломает отсчёт', minsk.formatCountdown(-5000) === '00:00:00');

// Год подряд: цель всегда в будущем, никогда не ночь на понедельник,
// дата брони = цель + 7 дней и тоже не понедельник.
let badTarget = 0;
let badBooking = 0;
let badFuture = 0;
let mondaysSkipped = 0;
for (let i = 0; i < 365; i += 1) {
  const now = Date.UTC(2026, 0, 1, 9, 0, 0) + i * 86400000;
  const t = minsk.nextRegistrationMidnight(now);
  const b = minsk.bookingDateFor(t);
  if (t.weekday === 1) badTarget += 1;
  if (b.weekday === 1) badBooking += 1;
  if (t.ms <= now) badFuture += 1;
  // Воскресный день → ближайшая полночь была бы понедельником, значит её пропустили.
  if (minsk.minskParts(now).weekday === 7) {
    mondaysSkipped += 1;
    if (t.weekday !== 2) badTarget += 1;
  }
}
check('цель всегда в будущем', badFuture === 0, `нарушений: ${badFuture}`);
check('ночь на понедельник пропускается', badTarget === 0, `проверено воскресений: ${mondaysSkipped}`);
check('дата брони никогда не понедельник', badBooking === 0, `нарушений: ${badBooking}`);

// Пятница 07.08.2026, 15:00 по Минску → ближайшая подача в ночь на субботу 08.08,
// откроется дата 15.08 (та же суббота неделей позже).
const t = minsk.nextRegistrationMidnight(Date.UTC(2026, 7, 7, 12, 0, 0));
const b = minsk.bookingDateFor(t);
check(
  'пример: пятница днём → подача в ночь на 08.08, бронь на 15.08',
  t.day === 8 && b.dateStr === '2026-08-15',
  `${minsk.formatDateRu(t)} → ${b.dateStr}`,
);
// Воскресенье днём: ночь на понедельник пропускается, подача — в ночь на вторник.
const tSun = minsk.nextRegistrationMidnight(Date.UTC(2026, 7, 9, 12, 0, 0));
check('пример: воскресенье → подача не в ночь на понедельник, а на вторник 11.08', tSun.day === 11, minsk.formatDateRu(tSun));
check('дата брони = цель + 7 дней', minsk.BOOKING_LEAD_DAYS === 7);

// --- Распознавание кабинета -------------------------------------------------
logger.info('--- Кабинет по полям формы ---');
const acc = loadLib('lib/account.js');

const FIELDS_LOGGED_IN = {
  n_persn: '4131195',
  fam: 'Иванова',
  name: 'Мария',
  otc: 'Петровна',
  t_contakt: '+375291234567',
  n_mail: 'ivanova@example.by',
  type_person: 'fiz',
  is_login: '1',
};
const a1 = acc.accountFromFields(FIELDS_LOGGED_IN);
check('ФИО собрано из полей', a1.fio === 'Иванова Мария Петровна', a1.fio);
check('кабинет распознан как залогиненный', a1.loggedIn === true);
check('короткое ФИО для узкой панели', acc.shortFio(a1) === 'Иванова М. П.', acc.shortFio(a1));

const a2 = acc.accountFromFields({ is_login: '1' });
check('пустое ФИО при is_login=1 = «не вошли»', a2.loggedIn === false);
const a3 = acc.accountFromFields({ fam: 'Иванова', name: 'Мария', is_login: '0' });
check('гость не выдаётся за кабинет', a3.loggedIn === false);
check('пустой объект не роняет разбор', acc.accountFromFields({}).fio === '' && acc.accountFromFields().loggedIn === false);

check(
  'страница подачи опознана по адресу и форме',
  acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/reg/fiz/', ['/rinki/minsk/create_zajav/']) === true,
);
check(
  'соседняя страница ЛК без формы не считается подачей',
  acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/account/', ['/rinki/minsk/logout/']) === false,
);
check(
  'посторонний сайт не считается подачей',
  acc.isSubmitPage('https://example.com/rinki/minsk/reg/fiz/', ['/rinki/minsk/create_zajav/']) === false,
);

check('готовность: всё хорошо', acc.readiness({ onSubmitPage: true, account: a1 }).ok === true);
check('готовность: не та страница', /не страница подачи/.test(acc.readiness({ onSubmitPage: false, account: a1 }).text));
check('готовность: кабинет не виден', /войдите на сайт/i.test(acc.readiness({ onSubmitPage: true, account: a2 }).text));

// --- Проверка на робота: токен (этап ext-2) ---------------------------------
logger.info('--- Токен проверки на робота ---');
const guard = loadLib('lib/guard.js');

check('поле токена Turnstile известно', guard.TOKEN_FIELD_NAMES[0] === 'cf-turnstile-response');
check('срок жизни токена — 5 минут', guard.TOKEN_TTL_MS === 300000);

check(
  'провайдер опознаётся по скрипту',
  guard.guardKindFromSources({ scripts: ['https://challenges.cloudflare.com/turnstile/v0/api.js'] }) === 'turnstile',
);
check('провайдер опознаётся по iframe виджета', guard.guardKindFromSources({ iframes: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x'] }) === 'turnstile');
check('провайдер опознаётся по классу контейнера', guard.guardKindFromSources({ classes: ['row', 'cf-turnstile'] }) === 'turnstile');
check('провайдер опознаётся по имени поля', guard.guardKindFromSources({ inputNames: ['fam', 'cf-turnstile-response'] }) === 'turnstile');
check('чужой провайдер не путается с Turnstile', guard.guardKindFromSources({ classes: ['g-recaptcha'] }) === 'recaptcha');
check('чистая страница — защиты нет', guard.guardKindFromSources({ scripts: ['/js/rinki/rinki.reg.js'], inputNames: ['fam'] }) === null);

// Ночной сценарий: полночь через 3 минуты.
const midnight = Date.UTC(2026, 7, 11, 21, 0, 0); // 00:00 по Минску
const t3 = midnight - 3 * 60 * 1000; // 23:57

const stFresh = guard.tokenStatus({ token: 'abc', seenAt: t3, now: t3 + 1000, targetMs: midnight });
check('токен, взятый в 23:57, доживает до полуночи', stFresh.state === 'valid' && stFresh.coversTarget === true, `остаток ${Math.round(stFresh.leftMs / 1000)} с`);

// Взят в 23:53:30 — сейчас ещё жив (полторы минуты в запасе), но до 00:00 не дотянет.
// Это самый коварный случай: панель обязана ругаться, пока токен выглядит рабочим.
const stEarly = guard.tokenStatus({ token: 'abc', seenAt: midnight - 6.5 * 60 * 1000, now: t3, targetMs: midnight });
check('живой токен, которому не хватит до полуночи, помечен как непригодный', stEarly.state === 'valid' && stEarly.coversTarget === false, `остаток ${Math.round(stEarly.leftMs / 1000)} с`);

const stExpired = guard.tokenStatus({ token: 'abc', seenAt: midnight - 9 * 60 * 1000, now: midnight - 2 * 60 * 1000, targetMs: midnight });
check('истёкший токен опознан', stExpired.state === 'expired' && stExpired.leftMs === 0);

const stSoon = guard.tokenStatus({ token: 'abc', seenAt: midnight - 4.5 * 60 * 1000, now: midnight - 30 * 1000, targetMs: midnight });
check('токен на исходе помечен отдельно', stSoon.state === 'soon');

const stNone = guard.tokenStatus({ token: '', now: t3, targetMs: midnight });
check('нет токена — состояние none, срок не выдумывается', stNone.state === 'none' && stNone.expiresAt === null && stNone.coversTarget === false);

const win = guard.refreshWindow(midnight);
check(
  'окно прохождения проверки: не раньше 23:55:30 и не позже 23:59:30',
  win.notBefore === midnight - 4.5 * 60 * 1000 && win.deadline === midnight - 30 * 1000,
);

// Подсказки человеку — то, ради чего этап и делался: предупредить ДО полуночи.
const advice = (o) => guard.guardAdvice({ kind: 'turnstile', widgetSeen: true, targetMs: midnight, ...o });

check(
  'задолго до полуночи отсутствие токена — не тревога',
  advice({ status: stNone, now: midnight - 40 * 60 * 1000, pageAgeMs: 5000 }).level === 'wait',
);
check(
  'в окне подачи отсутствие токена — тревога',
  advice({ status: stNone, now: t3, pageAgeMs: 60000 }).level === 'bad',
);
check(
  'виджет висит, токена нет — подсказываем нажать галочку',
  /галочку/.test(advice({ status: stNone, now: midnight - 40 * 60 * 1000, pageAgeMs: 30000 }).text),
);
check(
  'токен не доживёт до полуночи — предупреждаем заранее',
  advice({ status: stEarly, now: t3 }).level === 'bad' && /до полуночи/.test(advice({ status: stEarly, now: t3 }).text),
);
check('истёкший токен — прямое указание пройти заново', /заново/.test(advice({ status: stExpired, now: midnight - 2 * 60000 }).text));
check('всё хорошо — зелёный совет', advice({ status: stFresh, now: t3 + 1000 }).level === 'ok');
check(
  'токен был до открытия панели — просим обновить на всякий случай',
  advice({ status: guard.tokenStatus({ token: 'abc', seenAt: t3, issuedKnown: false, now: t3 + 1000, targetMs: midnight }), now: t3 + 1000 }).level === 'ok',
);
check(
  'проверки на странице нет — панель говорит и это',
  guard.guardAdvice({ kind: null, targetMs: midnight, now: t3, status: stNone }).level === 'wait',
);

check('время выдачи печатается по-мински', minsk.formatTimeRu(t3) === '23:57:00', minsk.formatTimeRu(t3));
check('остаток годности печатается как м:сс', minsk.formatLeft(271000) === '4:31', minsk.formatLeft(271000));

// Content script обязан читать токен опросом: виджет присваивает .value, и MutationObserver
// такое присваивание не видит — если опрос пропадёт, токен молча перестанет замечаться.
const contentSrc = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
check('токен считывается опросом (setInterval), а не только через MutationObserver', /setInterval\(pollGuard/.test(contentSrc));
// Панели отдаём факт и длину токена, но не сам токен: чем меньше мест, где он лежит,
// тем меньше поводов ему утечь. Проверяем именно блок ответа, а не весь файл —
// внутри content script токен, разумеется, есть.
const guardBlock = contentSrc.match(/guard:\s*\{[\s\S]*?\n {4}\},/)?.[0] || '';
check('блок ответа панели найден', guardBlock.length > 0);
check(
  'сам токен панели не отдаётся — только факт и длина',
  /hasToken/.test(guardBlock) && /tokenLength/.test(guardBlock) && !/\btoken:/.test(guardBlock),
);

// --- Сборка заявки: сверка с ботом (этап ext-3) -----------------------------
logger.info('--- Заявка create_zajav: расширение против бота ---');
const order = loadLib('lib/order.js', { formatDateRu: minsk.formatDateRu });

// Поля формы — общий вход для обеих сборок. Кириллица и телефон здесь не для красоты:
// именно на них видно, что кодирование тела совпадает байт в байт.
const FIELDS = {
  n_persn: '4131195',
  fam: 'Петрусевич',
  name: 'Мария',
  otc: 'Ивановна',
  t_contakt: '+375291234567',
  n_mail: 'test@example.by',
  type_person: 'fiz',
  is_login: '1',
};
const ORDER_ARGS = { fields: FIELDS, rinokId: 10, typeMesta: 2, day: 15, month: 8, year: 2026, assortIds: [2] };

const botPayload = buildCreateZajavPayload(ORDER_ARGS);
const extPayload = order.buildCreateZajavPayload(ORDER_ARGS);

check(
  'ключи и порядок полей совпадают с ботом',
  JSON.stringify(Object.keys(extPayload)) === JSON.stringify(Object.keys(botPayload)),
  Object.keys(extPayload).join(','),
);
const botBody = new URLSearchParams(botPayload).toString();
const extBody = order.encodeForm(extPayload);
check('тело запроса совпадает с ботом побайтово', extBody === botBody, `${extBody.length} байт`);
if (extBody !== botBody) {
  for (const k of Object.keys(botPayload)) {
    if (botPayload[k] !== extPayload[k]) logger.error(`   расхождение в ${k}: бот=${botPayload[k]} / расширение=${extPayload[k]}`);
  }
}

// Несколько дат подряд, включая переход через границу месяца и года: на каждой
// дате payload обеих сборок обязан совпадать.
let mismatched = 0;
for (const [d, m, y] of [
  [1, 1, 2027],
  [29, 2, 2028],
  [31, 8, 2026],
  [15, 8, 2026],
  [30, 12, 2026],
]) {
  const args = { ...ORDER_ARGS, day: d, month: m, year: y };
  if (order.encodeForm(order.buildCreateZajavPayload(args)) !== new URLSearchParams(buildCreateZajavPayload(args)).toString()) mismatched += 1;
}
check('совпадение держится на разных датах', mismatched === 0, `проверено 5 дат, расхождений ${mismatched}`);

// Несколько ассортиментов: ARR_ASSORT собирается индексами, порядок важен.
let assortMismatch = 0;
for (const ids of [[2], [1, 2], [2, 3, 6]]) {
  const args = { ...ORDER_ARGS, assortIds: ids };
  if (order.encodeForm(order.buildCreateZajavPayload(args)) !== new URLSearchParams(buildCreateZajavPayload(args)).toString()) assortMismatch += 1;
}
check('совпадение держится на разных наборах ассортимента', assortMismatch === 0);

check('константы кабинета: рынок 10, торговый ряд, овощи, 2 места', order.RINOK_ID === 10 && order.TYPE_MESTA_DEFAULT === 2 && order.ASSORT_DEFAULT[0] === 2 && order.BOOKINGS_PER_ACCOUNT === 2);
check('адрес подачи тот же, что у бота', order.CREATE_PATH === '/rinki/minsk/create_zajav/');

// Токен — единственное намеренное отличие от бота.
const withTok = order.withToken(extPayload, 'cf-turnstile-response', 'TOKEN123');
check('токен добавляется отдельным полем', order.encodeForm(withTok) === `${botBody}&cf-turnstile-response=TOKEN123`);
check('без токена payload остаётся как у бота', order.encodeForm(order.withToken(extPayload, 'cf-turnstile-response', '')) === botBody);
check('в предпросмотре вместо токена его длина', /cf-turnstile-response=<токен, 412 симв\.>$/.test(order.previewForm(extPayload, 'cf-turnstile-response', 412)));
check('предпросмотр не содержит самого токена', !order.previewForm(order.withToken(extPayload, 'cf-turnstile-response', 'SECRET'), 'cf-turnstile-response', 6).includes('SECRET'));

// Фраза человеку — то, что клиентка читает спросонья.
const bookingSat = { day: 15, month: 8, year: 2026, weekday: 6, dateStr: '2026-08-15' };
check(
  'план словами: «Подам 2 заявки на 15 августа, суббота — овощи»',
  order.describePlan({ count: 2, booking: bookingSat, assortIds: [2] }) === 'Подам 2 заявки на 15 августа, суббота — овощи',
  order.describePlan({ count: 2, booking: bookingSat, assortIds: [2] }),
);
check('одна заявка склоняется правильно', /Подам 1 заявку/.test(order.describePlan({ count: 1, booking: bookingSat, assortIds: [2] })));

// Помехи подаче видны заранее, а не в 00:00:00.
const okAcc = acc.accountFromFields(FIELDS);
check('всё готово — помех нет', order.planProblems({ account: okAcc, day: 15, hasToken: true, tokenField: 'cf-turnstile-response' }).length === 0);
check('нет токена — сказано прямо', /проверка на робота/.test(order.planProblems({ account: okAcc, day: 15, hasToken: false, tokenField: 'cf-turnstile-response' })[0]));
check('не вошли в кабинет — сказано прямо', /кабинет не виден/.test(order.planProblems({ account: acc.accountFromFields({}), day: 15, hasToken: true, tokenField: 'x' })[0]));

// Dry-run по-настоящему: в коде расширения не должно быть НИ ОДНОГО способа
// отправить запрос. Это проверяется по всем файлам, а не по флагу в настройках.
const extFiles = ['content.js', 'popup.js', 'lib/minsk.js', 'lib/account.js', 'lib/guard.js', 'lib/order.js'];
const senders = [];
for (const rel of extFiles) {
  const src = fs.readFileSync(path.join(EXT, rel), 'utf8');
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bform\.submit\s*\(/, /WebSocket/]) {
    if (re.test(src)) senders.push(`${rel}: ${re}`);
  }
}
check('в расширении нет ни одного способа отправки (настоящий dry-run)', senders.length === 0, senders.join('; ') || 'ни fetch, ни XHR, ни sendBeacon, ни form.submit');
check('в манифесте нет прав на фоновые запросы', !manifest.background && !(manifest.permissions || []).includes('webRequest'));

// --- Итог -------------------------------------------------------------------
if (failed) {
  logger.error(`Проверка не пройдена: ошибок ${failed}`);
  process.exit(1);
}
logger.info('Все проверки этапов ext-1…ext-3 пройдены. Осталась живая: поставить в Chrome по ext/README.md.');
