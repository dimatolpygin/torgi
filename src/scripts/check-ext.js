// UAT-скрипт этапов ext-1…ext-6: каркас расширения Chrome, считывание токена проверки,
// сборка заявки и точный выстрел. Офлайн: манифест, синтаксис файлов, логика библиотек
// (минское время, кабинет, годность токена, поправка часов, планировщик залпа) и
// побайтовая сверка payload create_zajav с ботом. Точность выстрела не обещается,
// а МЕРЯЕТСЯ — планировщик прогоняется здесь же настоящими таймерами.
// В сеть не ходит, Chrome не нужен.
// Запуск: node src/scripts/check-ext.js
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { buildCreateZajavPayload, parseGuard } from '../site/order.js';
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
  'права только на сам сайт и на эталон времени',
  JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://gorod.it-minsk.by/*', 'https://cloudflare.com/cdn-cgi/trace']),
  JSON.stringify(manifest.host_permissions),
);
// Эталон времени пущен ровно на одну служебную страницу, а не на весь домен.
check(
  'право на эталон времени сужено до одного адреса',
  (manifest.host_permissions || []).filter((h) => !h.includes('gorod.it-minsk.by')).every((h) => /^https:\/\/[^/*]+\/[^*]+$/.test(h)),
);
// Никаких permissions вообще: настройки доставки задаёт разработчик в config.js, поэтому
// хранилище не нужно. И никаких optional_host_permissions — раньше там стояли
// "http://*/*" и "https://*/*", то есть право на весь интернет у расширения, которое
// живёт рядом с сессией госкабинета. Убрано: адрес приёмника, когда он появится,
// вписывается в host_permissions одним конкретным адресом.
check('никаких permissions', !manifest.permissions || manifest.permissions.length === 0, JSON.stringify(manifest.permissions || []));
check(
  'нет права на весь интернет',
  !manifest.optional_host_permissions,
  JSON.stringify(manifest.optional_host_permissions || []),
);
check(
  'ни одного права со звёздочкой в домене',
  (manifest.host_permissions || []).every((h) => !/^https?:\/\/\*/.test(h)),
  JSON.stringify(manifest.host_permissions),
);
check(
  'фоновый скрипт один и только ради отчёта',
  manifest.background?.service_worker === 'background.js',
  JSON.stringify(manifest.background || {}),
);

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

for (const rel of ['lib/minsk.js', 'lib/account.js', 'lib/guard.js', 'lib/order.js', 'lib/clock.js', 'lib/shot.js', 'lib/outcome.js', 'lib/report.js', 'clocksync.js', 'content.js', 'popup.js', 'background.js']) {
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
for (const src of ['lib/minsk.js', 'lib/account.js', 'lib/guard.js', 'lib/order.js', 'lib/clock.js', 'lib/shot.js', 'clocksync.js', 'popup.js', 'popup.css']) {
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
const a1 = acc.accountFromFields(FIELDS_LOGGED_IN, { cabinetId: '3080000c000pb0' });
check('ФИО собрано, если сайт его дал', a1.fio === 'Иванова Мария Петровна', a1.fio);
check('кабинет распознан как залогиненный', a1.loggedIn === true);

// ГЛАВНОЕ ЗДЕСЬ (найдено 09.08.2026 на живом кабинете): сайт НЕ подставляет ФИО в форму
// даже вошедшему. Раньше вход определялся по непустому ФИО — с этим панель у клиентки
// была бы красной ВСЕГДА. Теперь судим по is_login.
const a2 = acc.accountFromFields({ is_login: '1' }, { cabinetId: '3080000c000pb0' });
check('пустое ФИО при is_login=1 — это ВОШЁЛ, а не гость', a2.loggedIn === true);
check('без ФИО кабинет называется по коду', acc.accountLabel(a2) === 'кабинет 3080000c000pb0', acc.accountLabel(a2));
check('ФИО, если оно есть, важнее кода', acc.accountLabel(a1) === 'Иванова Мария Петровна');
const a3 = acc.accountFromFields({ fam: 'Иванова', name: 'Мария', is_login: '0' }, {});
check('гость не выдаётся за кабинет', a3.loggedIn === false);
check('у гостя панель не пишет чужого кабинета', acc.accountLabel(a3) === 'не вижу');
check('пустой объект не роняет разбор', acc.accountFromFields({}).fio === '' && acc.accountFromFields().loggedIn === false);

const SUBMIT_MARKS = { formIds: ['form_reg'], inputNames: ['arr_date', 'type_mesta', 'assort_arr[]'] };
check('страница подачи опознана по форме form_reg', acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/reg/fiz/', SUBMIT_MARKS) === true);
check(
  'страница опознаётся и без id формы — по её полям',
  acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/reg/fiz/', { formIds: ['other'], inputNames: SUBMIT_MARKS.inputNames }) === true,
);
check(
  'соседняя страница ЛК не считается подачей',
  acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/account/', { formIds: ['form_reg'], inputNames: [] }) === false,
);
check('посторонний сайт не считается подачей', acc.isSubmitPage('https://example.com/rinki/minsk/reg/fiz/', SUBMIT_MARKS) === false);
check(
  'страница ЛК с формой логина не считается подачей',
  acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/reg/fiz/', { formIds: ['login'], inputNames: ['n_login', 'n_pass'] }) === false,
);

check('готовность: всё хорошо', acc.readiness({ onSubmitPage: true, account: a1 }).ok === true);
check('готовность: не та страница', /не страница подачи/.test(acc.readiness({ onSubmitPage: false, account: a1 }).text));
check('готовность: кабинет не виден', /войдите на сайт/i.test(acc.readiness({ onSubmitPage: true, account: a3 }).text));
// Ровно тот случай, который был сломан: вошли, но сайт ФИО не дал — панель обязана быть
// зелёной, а не гнать человека «войти» в кабинет, где он уже сидит.
check('готовность: вошёл без ФИО — всё равно зелено', acc.readiness({ onSubmitPage: true, account: a2 }).ok === true, acc.readiness({ onSubmitPage: true, account: a2 }).text);

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

// Ночь 11.08 живьём: Cloudflare написал «Сбой проверки», токена не было вовсе, а панель
// продолжала советовать нажать галочку. Совет обязан меняться, когда он перестал работать.
const stuckFar = advice({ status: stNone, now: midnight - 30 * 60 * 1000, pageAgeMs: 120000 });
const stuckNear = advice({ status: stNone, now: midnight - 60 * 1000, pageAgeMs: 120000 });
check('залипшая проверка признаётся залипшей, а не «нажмите галочку»', stuckFar.stuck === true && !/галочку/.test(stuckFar.text), stuckFar.text);
check('пока до полуночи далеко — предлагаем обновить страницу', /F5/.test(stuckFar.text));
check('за минуту до подачи обновлять страницу не советуем', !/F5/.test(stuckNear.text) && /пришлите/.test(stuckNear.text), stuckNear.text);
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

// Отправка сосчитана поимённо. До ext-5 здесь проверялось, что отправлять физически
// нечем; теперь боевая подача есть, и проверка стала строже: на странице сайта ровно
// ОДИН способ отправки, он живёт в lib/send.js и адресован create_zajav. Всё остальное —
// по-прежнему только чтение.
const extFiles = ['content.js', 'popup.js', 'lib/minsk.js', 'lib/account.js', 'lib/guard.js', 'lib/order.js', 'lib/clock.js', 'lib/shot.js', 'lib/outcome.js'];
const senders = [];
for (const rel of extFiles) {
  const src = fs.readFileSync(path.join(EXT, rel), 'utf8');
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bform\.submit\s*\(/, /WebSocket/]) {
    if (re.test(src)) senders.push(`${rel}: ${re}`);
  }
}
check('кроме файла подачи, на странице отправлять нечем', senders.length === 0, senders.join('; ') || 'ни fetch, ни XHR, ни sendBeacon, ни form.submit');
const sendSrc = fs.readFileSync(path.join(EXT, 'lib', 'send.js'), 'utf8');
check('в файле подачи ровно один запрос', (sendSrc.match(/\bfetch\s*\(/g) || []).length === 1, String((sendSrc.match(/\bfetch\s*\(/g) || []).length));
check('подача не умеет повторять попытки', !/\bfor\s*\(|\bwhile\s*\(|retry/i.test(sendSrc), 'ни цикла, ни retry');
check('заявка уходит с кукой кабинета', /credentials:\s*'same-origin'/.test(sendSrc));
check('заявка помечена как AJAX — иначе сайт не ответит JSON', /'x-requested-with':\s*'XMLHttpRequest'/.test(sendSrc));
check('в манифесте нет прав на перехват чужих запросов', !(manifest.permissions || []).includes('webRequest'));

const clocksyncSrc = fs.readFileSync(path.join(EXT, 'clocksync.js'), 'utf8');
check('сетевой файл не подключён к странице сайта', !(cs.js || []).includes('clocksync.js'));
check('панель подключает сетевой файл', popupHtml.includes('clocksync.js'));
check(
  'в сетевом файле ровно один запрос и он на объявленный эталон',
  (clocksyncSrc.match(/\bfetch\s*\(/g) || []).length === 1 && clocksyncSrc.includes("'https://cloudflare.com/cdn-cgi/trace'"),
);
// Главное для сайта: НИ ОДИН файл расширения к нему не обращается.
const siteCalls = [];
for (const rel of [...extFiles, 'clocksync.js', 'background.js', 'lib/report.js']) {
  const src = fs.readFileSync(path.join(EXT, rel), 'utf8');
  if (/(fetch|open|sendBeacon)\s*\([^)]*gorod\.it-minsk\.by/.test(src)) siteCalls.push(rel);
}
check('эталон времени не создаёт сайту ни одного запроса', siteCalls.length === 0 && !clocksyncSrc.includes('gorod.it-minsk.by'), siteCalls.join(', ') || '0 запросов к gorod.it-minsk.by');

// --- Живая страница сайта (фикстура) ----------------------------------------
// ext/dev/fixtures/reg-fiz.html — настоящая страница подачи, снятая 07.08.2026 через
// минский прокси (снаружи Беларуси сайт не отвечает вовсе). На ней проверяем то, о чём
// раньше приходилось догадываться: как называются поля и чем закрыта форма.
logger.info('--- Живая страница сайта (фикстура 07.08.2026) ---');
const fixture = fs.readFileSync(path.join(EXT, 'dev', 'fixtures', 'reg-fiz.html'), 'utf8');

const fixtureGuard = parseGuard(fixture);
check('на живой странице стоит Turnstile', fixtureGuard.kind === 'turnstile' && fixtureGuard.widget && fixtureGuard.script);
check('sitekey формы прочитан', fixtureGuard.sitekey === '0x4AAAAAAEFKBE3GIyNp4fk-', fixtureGuard.sitekey);
check(
  'поле токена в HTML отсутствует — его создаёт виджет в браузере',
  fixtureGuard.tokenField === null && fixtureGuard.tokenFieldExpected === 'cf-turnstile-response',
);

// Приметы страницы, по которым content script её узнаёт.
const fixtureIds = [...fixture.matchAll(/<form\b[^>]*\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
const fixtureNames = [...fixture.matchAll(/<(?:input|select)\b[^>]*\bname=["']([^"']+)["']/gi)].map((m) => m[1]);
check('форма подачи на живой странице — form_reg', fixtureIds.includes('form_reg'), fixtureIds.join(', '));
check(
  'у формы подачи НЕТ action (адрес подставляет скрипт сайта)',
  !/<form\b[^>]*id=["']form_reg["'][^>]*\baction=/i.test(fixture) && !fixture.includes('create_zajav'),
);
check('живая страница опознаётся как страница подачи', acc.isSubmitPage('https://gorod.it-minsk.by/rinki/minsk/reg/fiz/', { formIds: fixtureIds, inputNames: fixtureNames }) === true);

// Селекторы content script должны попадать в РЕАЛЬНЫЕ имена полей, а не в выдуманные.
check('ассортимент на странице называется assort_arr[]', fixtureNames.includes('assort_arr[]'));
check('селектор ассортимента (name*="assort") попадает в это имя', fixtureNames.some((n) => /assort/i.test(n)));
check('тип места на странице — select name="type_mesta"', /<select\b[^>]*name=["']type_mesta["']/i.test(fixture));
check('селектор типа места (name*="type_mest") попадает в это имя', fixtureNames.some((n) => /type_mest/i.test(n)));
check('ассортимент — чекбоксы со значениями 1..6', (fixture.match(/name=["']assort_arr\[\]["']\s+value=["'](\d)["']/gi) || []).length === 6);
check('поля персоны из сборки заявки есть на странице', ['fam', 'name', 'otc', 'n_persn', 't_contakt', 'n_mail'].every((n) => fixtureNames.includes(n)));

// --- Живая страница ЗАЛОГИНЕННОГО кабинета ----------------------------------
// ext/dev/fixtures/reg-fiz-logged.html — та же форма, но снятая после входа (09.08.2026,
// через минский прокси, код кабинета и пароли в файле заменены на образец). Именно она
// вскрыла главный баг этапа ext-1.
logger.info('--- Живая страница залогиненного кабинета (09.08.2026) ---');
const fixLogged = fs.readFileSync(path.join(EXT, 'dev', 'fixtures', 'reg-fiz-logged.html'), 'utf8');

const valueOf = (html, name) => {
  const m = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i').exec(html);
  return m ? m[1] : null;
};
check('у вошедшего в форме есть is_login=1', valueOf(fixLogged, 'is_login') === '1');
check('у анонима поля is_login в форме НЕТ вовсе', valueOf(fixture, 'is_login') === null);
// Вот он, найденный баг: ФИО в форме пустое даже у вошедшего.
check(
  'сайт НЕ подставляет ФИО вошедшему (из-за этого панель была красной всегда)',
  ['fam', 'name', 'otc', 'n_persn', 't_contakt', 'n_mail'].every((n) => !valueOf(fixLogged, n)),
);

const hdr = acc.parseHeader(fixLogged);
check('код кабинета читается из шапки', hdr.cabinetId === '3080000c000pb0', hdr.cabinetId);
check('у анонима кода кабинета нет', acc.parseHeader(fixture).cabinetId === '');
check('в фикстуру не утёк настоящий код кабинета', !/308039/.test(fixLogged));

const live = acc.accountFromFields({ is_login: valueOf(fixLogged, 'is_login') || '' }, hdr);
check('на живой залогиненной странице кабинет виден', live.loggedIn === true);
check('и называется кодом кабинета', acc.accountLabel(live) === 'кабинет 3080000c000pb0', acc.accountLabel(live));
check('на живой анонимной странице кабинет не виден', acc.accountFromFields({}, acc.parseHeader(fixture)).loggedIn === false);

// --- Панель без лишнего для клиента -----------------------------------------
logger.info('--- В панели нет ничего лишнего для клиента ---');
const popupSrc = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
for (const [what, needle] of [
  ['предпросмотра запроса', 'plan-preview'],
  ['тренировочного залпа', 'drill-btn'],
  ['полей адреса и пароля', 'rep-url'],
  ['технических миллисекунд сети', 'дорога'],
]) {
  check(`в панели нет ${what}`, !popupHtml.includes(needle) && !popupSrc.includes(needle));
}
check('тренировочный залп остался в инструменте разработчика', previewHtml.includes('drill-btn'));
check('настройки доставки — в config.js, не в панели', fs.existsSync(path.join(EXT, 'config.js')) && !popupHtml.includes('rep-secret'));
// Пока адрес приёмника пуст, наружу не уходит ничего — и это видно из кода, а не из слов.
const cfg = loadLib('config.js');
check('доставка итога выключена, пока адрес не задан', cfg.reportConfigured() === false);

// --- Часы: поправка (этап ext-4) --------------------------------------------
logger.info('--- Часы компьютера и поправка ---');
const clk = loadLib('lib/clock.js', { Math });

// Формула NTP: дорога туда и обратно считается равной, поэтому время сервера сравниваем
// с СЕРЕДИНОЙ окна запроса, а не с его началом.
const p1 = clk.probeOffset({ t0: 1000, serverMs: 1600, t1: 1200 });
check('одна проба считается по формуле NTP', p1.offsetMs === 500 && p1.rttMs === 200, `offset=${p1.offsetMs}, rtt=${p1.rttMs}`);

// Одна проба застряла в сети на секунду и назвала дикую поправку. Медиана по половине
// с наименьшим RTT обязана её выбросить — иначе один тормоз сети сдвинет весь выстрел.
const merged = clk.mergeProbes([
  { offsetMs: 120, rttMs: 30 },
  { offsetMs: 118, rttMs: 34 },
  { offsetMs: 700, rttMs: 1200 },
  { offsetMs: 125, rttMs: 40 },
  { offsetMs: 640, rttMs: 900 },
]);
check('выброс по медленной пробе отброшен', merged.ok && merged.offsetMs === 120, `offset=${merged.offsetMs}, взято ${merged.used} из ${merged.samples}`);
check('за RTT берётся лучшая проба', merged.rttMs === 30, String(merged.rttMs));
check('пустой замер не выдаёт себя за удачный', clk.mergeProbes([]).ok === false);

check('мелкая поправка не применяется (это шум сети)', clk.usableOffset({ ok: true, offsetMs: 8, spreadMs: 5 }) === 0);
check('крупная поправка применяется', clk.usableOffset({ ok: true, offsetMs: 2500, spreadMs: 20 }) === 2500);
check('замер с большим разбросом не применяется', clk.usableOffset({ ok: true, offsetMs: 2500, spreadMs: 900 }) === 0);
check('несостоявшийся замер не двигает выстрел', clk.usableOffset({ ok: false, offsetMs: 5000 }) === 0);

check('часы точны → зелёная строка', clk.clockVerdict({ ok: true, offsetMs: 4, spreadMs: 10 }).level === 'ok');
check(
  'часы врут больше секунды → предупреждение',
  clk.clockVerdict({ ok: true, offsetMs: 3200, spreadMs: 20 }).level === 'warn',
  clk.clockVerdict({ ok: true, offsetMs: 3200, spreadMs: 20 }).text,
);
check('замер не удался → честно сказано, что стреляем по часам ПК', clk.clockVerdict({ ok: false }).level === 'warn');

// Знак поправки — место, где легко ошибиться на два раза по величине сдвига.
// Часы СПЕШАТ на 3 с (offset = настоящее − местное = −3000): настоящая полночь наступит
// по местным часам на 3 с ПОЗЖЕ отметки 00:00:00.
const T = Date.UTC(2026, 7, 10, 21, 0, 0);
check('часы спешат → ждём дольше', clk.localTargetMs(T, -3000) === T + 3000);
check('часы отстают → стреляем раньше', clk.localTargetMs(T, 2000) === T - 2000);
check('поправка форматируется для человека', clk.formatOffset(-1500) === '−1.50 с' && clk.formatOffset(47) === '+47 мс', `${clk.formatOffset(-1500)} / ${clk.formatOffset(47)}`);

// --- Выстрел: планировщик и залп (этап ext-4) --------------------------------
logger.info('--- Точность выстрела и одномоментность залпа ---');
const shot = loadLib('lib/shot.js', { Math, setTimeout, Promise });

check('ложная цель — ближайшая ровная минута', shot.nextRoundMinute(Date.UTC(2026, 7, 10, 12, 34, 20)) === Date.UTC(2026, 7, 10, 12, 35, 0));
check('до ровной минуты меньше секунды → берём следующую', shot.nextRoundMinute(Date.UTC(2026, 7, 10, 12, 34, 59, 500)) === Date.UTC(2026, 7, 10, 12, 36, 0));

// Точность НЕ обещается, а меряется: заводим планировщик на 400 мс вперёд настоящими
// таймерами и смотрим, на сколько он разошёлся с целью.
const drills = [];
for (let i = 0; i < 3; i += 1) {
  const target = Date.now() + 400;
  const report = await shot.shootAt({
    localTargetMs: target,
    offsetMs: 0,
    count: 2,
    sendOne: (idx) => ({ dryRun: true, idx }),
  });
  drills.push(report);
}
const worstDrift = Math.max(...drills.map((r) => Math.abs(r.driftMs)));
const worstSpread = Math.max(...drills.map((r) => r.spreadMs));
check('выстрел попадает в цель (замер, а не обещание)', worstDrift <= 5, `худшее отклонение ${worstDrift} мс из 3 прогонов`);
check('выстрел не приходит РАНЬШЕ цели', drills.every((r) => r.driftMs >= 0), drills.map((r) => r.driftMs).join(', '));
check('обе заявки уходят одномоментно', worstSpread <= 2 && drills.every((r) => r.parallel), `худший разъезд ${worstSpread} мс`);
check('в залпе ровно столько отправок, сколько мест', drills.every((r) => r.count === 2 && r.results.length === 2));
check('на этапе ext-4 залп тренировочный', drills.every((r) => r.results.every((x) => x.ok && x.result.dryRun === true)));

// Поправка часов должна реально двигать момент выстрела, а не украшать панель.
// Делаем вид, что часы отстают на 300 мс: цель в настоящем времени = now+700,
// значит по местным часам стрелять надо в now+400.
const trueTarget = Date.now() + 700;
const withOffset = await shot.shootAt({
  localTargetMs: clk.localTargetMs(trueTarget, 300),
  offsetMs: 300,
  count: 1,
  sendOne: () => ({ dryRun: true }),
});
check(
  'поправка часов сдвигает момент выстрела',
  Math.abs(withOffset.atTrueMs - trueTarget) <= 5 && withOffset.at < trueTarget,
  `по местным часам ${withOffset.at - trueTarget} мс до цели, в настоящем времени ${withOffset.atTrueMs - trueTarget} мс`,
);

// Залп не должен рассыпаться, если одна отправка упала: вторая обязана уйти.
const oneBroken = await shot.volley(2, (i) => {
  if (i === 0) throw new Error('сокет отвалился');
  return { dryRun: true };
}, {});
check('падение одной отправки не срывает вторую', oneBroken.results.length === 2 && oneBroken.results[0].ok === false && oneBroken.results[1].ok === true);

// Отчёт для человека.
const rep = shot.volleyReport({ localTargetMs: 1000, offsetMs: 0, starts: [1003, 1004], results: [] });
check('отчёт различает отклонение и разъезд', rep.driftMs === 3 && rep.spreadMs === 1, rep.text);
check('вразнобой видно в тексте', /вразнобой/.test(shot.describeShot({ count: 2, driftMs: 2, spreadMs: 40, parallel: false })));

// --- Этап ext-6: итог ночи и его доставка ------------------------------------
logger.info('--- Итог ночи: разбор ответов сайта ---');
const outcome = loadLib('lib/outcome.js', { formatDateRu: minsk.formatDateRu });
const answered = (code, extra = {}) => ({ ok: true, result: { status: 200, text: JSON.stringify({ code, ...extra }) } });
const BOOKING = minsk.bookingDateFor(minsk.nextRegistrationMidnight());

check('code 201 — заявка принята', outcome.readAnswer(answered('201')).accepted === true);
check('code 200 — тоже принята (кабинет создан)', outcome.readAnswer(answered('200')).accepted === true);
const rejNamed = outcome.readAnswer(answered('500', { arr_date: 'no_date' }));
check('отказ с полем — причина названа словами', rejNamed.accepted === false && /места разобрали/.test(rejNamed.reason), rejNamed.reason);
// Ночи 06–07.08 показали главный реальный случай: code=500 и НИ ОДНОГО поля-ошибки.
const rejMute = outcome.readAnswer(answered('500'));
check('молчаливый отказ не выдумывает причину', /причину не назвал/.test(rejMute.reason), rejMute.reason);
const rl = outcome.readAnswer({ ok: true, result: { status: 429, text: '' } });
check('429 распознан как ограничение частоты', rl.kind === 'ratelimit' && /частот/.test(rl.reason));
const notJson = outcome.readAnswer({ ok: true, result: { status: 200, text: '<html><body>Ошибка на сервере</body></html>' } });
check('не-JSON распознан как страница, а не ответ', notJson.kind === 'notjson' && /страницу/.test(notJson.reason));
check('упавшая отправка — это не отказ сайта', outcome.readAnswer({ ok: false, error: 'сокет отвалился' }).kind === 'network');
check('тренировка видна как тренировка', outcome.readAnswer({ ok: true, result: { dryRun: true } }).kind === 'drill');

const sumOk = outcome.summarize({ results: [answered('201'), answered('201')], booking: BOOKING, shot: { driftMs: 42, spreadMs: 1 } });
check('2 из 2 — «принято»', sumOk.ok && sumOk.acceptedCount === 2 && /Принято 2 из 2/.test(sumOk.text), sumOk.text);
const sumPart = outcome.summarize({ results: [answered('201'), answered('500')], booking: BOOKING });
check('1 из 2 — «принято частично» с причиной', sumPart.partial && !sumPart.ok && /Принято 1 из 2/.test(sumPart.text), sumPart.text);
const sumFail = outcome.summarize({ results: [answered('500'), answered('500')], booking: BOOKING });
check('0 из 2 — отказ, причина одна, а не задвоенная', !sumFail.ok && sumFail.acceptedCount === 0 && sumFail.reasons.length === 1, sumFail.text);
const sumDrill = outcome.summarize({ results: [{ ok: true, result: { dryRun: true } }], booking: BOOKING });
check('тренировочный залп не выдаёт себя за боевой', sumDrill.drill && !sumDrill.ok && /на сайт ничего не ушло/.test(sumDrill.text), sumDrill.text);
check('точность выстрела доезжает до итога', sumOk.driftMs === 42 && sumOk.spreadMs === 1);

logger.info('--- Отчёт: что уходит наружу ---');
const body = outcome.reportBody({
  outcome: sumOk,
  account: { fio: 'Иванова М. П.' },
  booking: BOOKING,
  now: 1_700_000_000_000,
});
const bodyJson = JSON.stringify(body);
// Главное правило: наружу уходит ровно то, что человек и так увидит в Telegram.
for (const forbidden of ['token', 'cf-turnstile', 'pass', 'cookie', 'gorodid', 'PERSN', 'n_mail', 't_contakt']) {
  check(`в отчёте нет «${forbidden}»`, !bodyJson.toLowerCase().includes(forbidden.toLowerCase()));
}
check('в отчёте есть кабинет, дата и итог', body.account.fio === 'Иванова М. П.' && body.booking.date === BOOKING.dateStr && !!body.text);

logger.info('--- Подпись отчёта: расширение и сервер понимают друг друга ---');
const { signReport, verifyReport, createExtReportHandler, SIG_HEADER, TS_HEADER } = await import('../ext-report.js');
const report = loadLib('lib/report.js', { crypto: globalThis.crypto, TextEncoder, Uint8Array, setTimeout, clearTimeout, AbortController, fetch: undefined });
const SECRET = 'секрет-для-проверки-длиннее-16';
const TS = '1700000000000';
const extSig = await report.signBody(TS, bodyJson, SECRET, globalThis.crypto.subtle);
check('подпись расширения совпадает с подписью сервера', extSig === signReport(TS, bodyJson, SECRET), extSig.slice(0, 16) + '…');
check('сервер принимает правильную подпись', verifyReport({ ts: TS, signature: extSig, bodyJson, secret: SECRET, now: Number(TS) }).ok);
check('подделанное тело не проходит', !verifyReport({ ts: TS, signature: extSig, bodyJson: bodyJson.replace('Иванова', 'Петрова'), secret: SECRET, now: Number(TS) }).ok);
check('чужой секрет не проходит', !verifyReport({ ts: TS, signature: extSig, bodyJson, secret: SECRET + 'x', now: Number(TS) }).ok);
check('старый отчёт не переслать повторно', !verifyReport({ ts: TS, signature: extSig, bodyJson, secret: SECRET, now: Number(TS) + 10 * 60_000 }).ok);
check('отчёт «из будущего» тоже отклоняется', !verifyReport({ ts: TS, signature: extSig, bodyJson, secret: SECRET, now: Number(TS) - 10 * 60_000 }).ok);
check('без секрета сервер не принимает ничего', !verifyReport({ ts: TS, signature: extSig, bodyJson, secret: '', now: Number(TS) }).ok);
check('подпись другой длины не роняет сервер', !verifyReport({ ts: TS, signature: 'abc', bodyJson, secret: SECRET, now: Number(TS) }).ok);

logger.info('--- Настройки доставки и живучесть ---');
check('без адреса отчёт не уйдёт и это сказано', /адрес/.test(report.reportSettingsProblems({ secret: SECRET })[0]));
check('короткий секрет не принимается', report.reportSettingsProblems({ url: 'https://x/y', secret: 'коротко' }).some((p) => /16 символов/.test(p)));
check('настройки в порядке — претензий нет', report.reportSettingsProblems({ url: 'https://x/y', secret: SECRET }).length === 0);

let seen = null;
const okSend = await report.sendReport({
  url: 'https://example.test/ext/report',
  secret: SECRET,
  body,
  now: Number(TS),
  subtle: globalThis.crypto.subtle,
  fetchImpl: async (url, init) => {
    seen = { url, init };
    return { status: 200 };
  },
});
check('отчёт уходит с подписью и временем в заголовках', okSend.ok && seen.init.headers['x-bron-signature'] === extSig && seen.init.headers['x-bron-ts'] === TS);
const deadServer = await report.sendReport({ url: 'https://example.test/x', secret: SECRET, body, subtle: globalThis.crypto.subtle, fetchImpl: async () => ({ status: 502 }) });
check('сервер лежит — отчёт честно говорит «не ушло», но не падает', deadServer.ok === false && /502/.test(deadServer.error));
const noNet = await report.sendReport({ url: 'https://example.test/x', secret: SECRET, body, subtle: globalThis.crypto.subtle, fetchImpl: async () => { throw new Error('сети нет'); } });
check('интернета нет — исключение не вылетает наружу', noNet.ok === false && /сети нет/.test(noNet.error));

// Отчёт вторичен по отношению к подаче: он вызывается ПОСЛЕ залпа и его результат
// никуда не влияет. Проверяем это по коду страницы, а не на словах.
const contentAfterShot = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
check(
  'отчёт отправляется только после залпа',
  contentAfterShot.indexOf('lastShot = report') < contentAfterShot.indexOf('deliverReport(report, bookingAtArm'),
);
check('итог считается сразу после залпа и лежит в состоянии для панели', /report\.outcome = summarize\(/.test(contentAfterShot) && /outcome: lastShot/.test(contentAfterShot));
check('панель показывает итог сама, без обновления страницы', fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8').includes('renderOutcome(state)'));

// Блок «что-то не так»: одна просьба, одна кнопка, и только когда есть о чём просить.
const popupJs = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
check('в панели есть блок «что-то не так»', popupHtml.includes('id="trouble"') && popupHtml.includes('id="copy-btn"'));
check('блок появляется только по делу', /if \(!reason\) \{\s*box\.style\.display = 'none';/.test(popupJs));
check('человека просят прислать картинку', /Сфотографируйте это окно/.test(popupJs));
check('кнопка кладёт текст в буфер обмена', /navigator\.clipboard\.writeText\(troubleReport/.test(popupJs));

// Ловушка, на которую я уже наступил: блок скрыт в стилях через display:none, а код
// показывает его присваиванием style.display = '' — пустая строка откатывает к стилю,
// то есть блок остаётся невидимым. Так «Итог ночи» с этапа ext-6 не показался бы ни разу.
check('панель показывает блоки явным значением, а не пустой строкой', !/style\.display = '';/.test(popupJs), "ни одного пустого display");
const popupCss = fs.readFileSync(path.join(EXT, 'popup.css'), 'utf8');
for (const cls of ['outcome', 'trouble']) {
  const hidden = new RegExp(`\.${cls}\s*\{[^}]*display:\s*none`).test(popupCss);
  const shown = new RegExp(`\$\('${cls}'\)`).test(popupJs) || popupJs.includes(`'${cls}'`);
  check(`скрытый в стилях блок «${cls}» показывается явно`, !hidden || /style\.display = 'block';/.test(popupJs), `скрыт в css: ${hidden}, показан явно: ${shown}`);
}
// В пересылаемом тексте не должно быть ничего, чего человек не должен отдавать.
const reportFn = popupJs.slice(popupJs.indexOf('function troubleReport'), popupJs.indexOf('// Внизу мелким'));
check('в тексте для пересылки нет ни токена, ни куки, ни пароля', !/token(?!.*hasToken)|cookie|pass/i.test(reportFn.replace(/hasToken/g, '')), 'только слова о состоянии');

// Секрета в репозитории быть не должно — ни в расширении, ни в коде бота.
const repoFiles = ['ext/background.js', 'ext/popup.js', 'ext/lib/report.js', 'ext/content.js', 'src/ext-report.js', 'src/config.js'];
const leaks = [];
for (const rel of repoFiles) {
  const src = fs.readFileSync(path.resolve(rel), 'utf8');
  // Присваивание секрету строкового литерала = утечка. Чтение из настроек/окружения — нет.
  if (/(reportSecret|EXT_REPORT_SECRET)\s*[:=]\s*['"][^'"]{6,}/.test(src)) leaks.push(rel);
}
check('общего слова нет в коде — только в настройках и .env', leaks.length === 0, leaks.join(', ') || 'ни одного литерала');

logger.info('--- Живой прогон: расширение → сервер → Telegram ---');
const sent = [];
const handler = createExtReportHandler({ notifier: { notify: async (t) => sent.push(t) }, secret: SECRET, path: '/ext/report' });
const srv = http.createServer(handler);
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

async function post(pathname, json, { ts = String(Date.now()), sig = null, secret = SECRET } = {}) {
  const signature = sig || signReport(ts, json, secret);
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIG_HEADER]: signature, [TS_HEADER]: ts },
    body: json,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const liveBody = JSON.stringify(outcome.reportBody({ outcome: sumOk, account: { fio: 'Иванова М. П.' }, booking: BOOKING }));
const good = await post('/ext/report', liveBody);
check('правильный отчёт принят сервером', good.status === 200 && good.body.ok === true, `HTTP ${good.status}`);
check('в Telegram ушёл один итог и он читается человеком', sent.length === 1 && /Итог ночной подачи/.test(sent[0]) && /забронировано/.test(sent[0]), sent[0]?.split('\n')[0]);
const tampered = await post('/ext/report', liveBody.replace('Иванова', 'Петрова'), { sig: signReport(String(Date.now()), liveBody, SECRET) });
check('подделанный отчёт отбит', tampered.status === 401 && sent.length === 1, `HTTP ${tampered.status}`);
const wrongSecret = await post('/ext/report', liveBody, { secret: 'другое-длинное-слово-1234' });
check('отчёт с чужим словом отбит', wrongSecret.status === 401 && sent.length === 1, `HTTP ${wrongSecret.status}`);
const wrongPath = await post('/ext/other', liveBody);
check('посторонний адрес на сервере — 404', wrongPath.status === 404);
// Telegram упал — отчёт всё равно принят: иначе расширение показало бы клиентке
// «отчёт не ушёл», хотя проблема не у неё.
const brokenTg = createExtReportHandler({ notifier: { notify: async () => { throw new Error('telegram лежит'); } }, secret: SECRET });
const srv2 = http.createServer(brokenTg);
await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
const ts2 = String(Date.now());
const res2 = await fetch(`http://127.0.0.1:${srv2.address().port}/ext/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', [SIG_HEADER]: signReport(ts2, liveBody, SECRET), [TS_HEADER]: ts2 },
  body: liveBody,
});
check('падение Telegram не делает ночь «неотчитавшейся»', res2.status === 200);
srv.close();
srv2.close();

// Тексты в Telegram — как у бота, чтобы клиентка не различала источник.
const { extResultText } = await import('../messages.js');
const tgOk = extResultText(outcome.reportBody({ outcome: sumOk, account: { fio: 'Иванова М. П.' }, booking: BOOKING }));
const tgPart = extResultText(outcome.reportBody({ outcome: sumPart, account: { fio: 'Иванова М. П.' }, booking: BOOKING }));
const tgFail = extResultText(outcome.reportBody({ outcome: sumFail, account: { fio: 'Иванова М. П.' }, booking: BOOKING }));
const tgDrill = extResultText(outcome.reportBody({ outcome: sumDrill, account: { fio: 'Иванова М. П.' }, booking: BOOKING }));
check('успех — зелёный и с числом мест', /🟢/.test(tgOk) && /2 места/.test(tgOk));
check('частично — жёлтый и просит добавить вручную', /🟡/.test(tgPart) && /вручную/.test(tgPart));
check('отказ — красный и с причиной', /🔴/.test(tgFail) && /Причина/.test(tgFail));
check('тренировка помечена тренировкой', /тренировка/.test(tgDrill));
check('видно, что подало расширение, а не бот', /из браузера/.test(tgOk));
check('точность выстрела в сообщении есть', /Точность выстрела/.test(tgOk));

// --- Боевая подача (этап ext-5) ---------------------------------------------
// Здесь проверяется то, что раньше было заглушкой: расширение действительно умеет
// отправить заявку. Сайт при этом не трогается ни разу — fetch подменяется, и видно,
// что именно ушло бы.
logger.info('--- Боевая подача: что и как уходит ---');
const send = loadLib('lib/send.js', {
  encodeForm: order.encodeForm,
  setTimeout,
  clearTimeout,
  AbortController,
});

check('расширение уезжает клиентке боевым, а не тренировочным', cfg.LIVE_SUBMIT === true);
const csJs = cs.js || [];
check('настройки подключены к странице раньше кода', csJs.indexOf('config.js') === 0);
check('файл подачи подключён к странице до content.js', csJs.indexOf('lib/send.js') > 0 && csJs.indexOf('lib/send.js') < csJs.indexOf('content.js'));

// Тело готовится заранее — в 00:00:00.000 к нему только приклеивается свежий токен.
const sendPayload = buildCreateZajavPayload({
  fields: FIELDS,
  rinokId: 10,
  typeMesta: 2,
  day: 15,
  month: 8,
  year: 2026,
  assortIds: [2],
});
const prefix = send.prepareBody(sendPayload);
check('заготовка тела — то же, что шлёт бот', prefix === order.encodeForm(sendPayload));
check('в заготовке нет поля токена', !prefix.includes('cf-turnstile-response'));
const liveBodyText = send.bodyWithToken(prefix, 'cf-turnstile-response', 'AAA.BBB+CCC/DDD=');
check('токен приклеивается последним полем', liveBodyText.startsWith(`${prefix}&cf-turnstile-response=`));
check('токен кодируется, а не ломает тело', liveBodyText.endsWith('AAA.BBB%2BCCC%2FDDD%3D'), liveBodyText.slice(-30));
check('без токена тело остаётся собой', send.bodyWithToken(prefix, 'cf-turnstile-response', '') === prefix);

// Что именно уходит на сайт — смотрим подменённым fetch.
let sentReq = null;
const fakeFetch = (url, opts) => {
  sentReq = { url, opts };
  return Promise.resolve({ status: 200, text: () => Promise.resolve('{"code":"201"}') });
};
const okRes = await send.submitOnce({ url: '/rinki/minsk/create_zajav/', body: liveBodyText, deps: { fetch: fakeFetch } });
check('адрес подачи — тот же, что у бота', sentReq.url === '/rinki/minsk/create_zajav/', sentReq.url);
check('метод POST', sentReq.opts.method === 'POST');
check('кука кабинета уезжает с заявкой', sentReq.opts.credentials === 'same-origin');
check('тело — form-urlencoded, как ждёт сайт', sentReq.opts.headers['content-type'].startsWith('application/x-www-form-urlencoded'));
check('запрос помечен как AJAX', sentReq.opts.headers['x-requested-with'] === 'XMLHttpRequest');
check('ответ сервера возвращается как есть', okRes.status === 200 && okRes.text === '{"code":"201"}');
check('принятая заявка опознана итогом', outcome.readAnswer(okRes).accepted === true);

// Ночь 04.08: вместо JSON пришла страница проверки. Так это и должно называться.
const challenge = await send.submitOnce({ url: '/x/', body: 'a=1', deps: { fetch: () => Promise.resolve({ status: 403, text: () => Promise.resolve('<html>Just a moment…</html>'), headers: { get: () => '' } }) } });
check('страница челленджа не выдаётся за отказ по полям', outcome.readAnswer(challenge).kind === 'challenge', outcome.readAnswer(challenge).reason);

// Интернет отвалился. Это не «сайт отклонил» — разница для человека принципиальная.
const dead = await send.submitOnce({ url: '/x/', body: 'a=1', deps: { fetch: () => Promise.reject(new Error('Failed to fetch')) } });
check('обрыв связи назван обрывом, а не отказом сайта', dead.networkError && outcome.readAnswer(dead).kind === 'network', outcome.readAnswer(dead).reason);

// Сервер молчит дольше отведённого — ждать до утра нельзя.
const hung = await send.submitOnce({
  url: '/x/',
  body: 'a=1',
  timeoutMs: 40,
  deps: { fetch: (_u, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) },
});
check('молчащий сервер обрывается по таймауту', /не ответил вовремя/.test(hung.networkError || ''), hung.networkError);

// Заявку осознанно не отправили — это отдельный исход, не отказ и не сбой.
const skipAnswer = outcome.readAnswer({ skipped: 'проверка на робота не пройдена — заявка не отправлена' });
check('«не отправляли» показано отдельно от отказа', skipAnswer.kind === 'skipped' && /проверка на робота/.test(skipAnswer.reason));

// Две открытые вкладки формы — стреляет одна. Иначе кабинет получил бы 4 заявки на
// лимите в 2 места и рисковал бы нарваться на ограничение частоты.
const claims = new Map();
const c1 = send.decideClaim(claims, 1770000000000, 11);
const c2 = send.decideClaim(claims, 1770000000000, 22);
const c1again = send.decideClaim(claims, 1770000000000, 11);
const cNext = send.decideClaim(claims, 1770086400000, 22);
check('право на подачу получает первая вкладка', c1.granted === true);
check('вторая вкладка молчит', c2.granted === false && c2.holder === 11);
check('та же вкладка подтверждает своё право', c1again.granted === true);
check('на следующую ночь право разыгрывается заново', cNext.granted === true);

// Залп: обе заявки уходят в одном такте и с ОДНИМ И ТЕМ ЖЕ токеном. Хватит ли одного
// токена на два места — вопрос A, его закрывает живая ночь; здесь фиксируется, что
// расширение шлёт именно так, и по ответу сервера будет что разбирать.
const bodies = [];
const volleyRes = await shot.volley(2, (i) => {
  bodies.push(send.bodyWithToken(prefix, 'cf-turnstile-response', 'TOKEN-XYZ'));
  return { status: 200, text: `{"code":"201","i":${i}}` };
});
check('в залпе ровно две заявки', volleyRes.results.length === 2);
check('обе заявки несут один и тот же токен', bodies[0] === bodies[1] && bodies[0].includes('TOKEN-XYZ'));
check('обе заявки собраны в одном такте', volleyRes.starts[1] - volleyRes.starts[0] <= 2, `разъезд ${volleyRes.starts[1] - volleyRes.starts[0]} мс`);

// Часы уточнились уже после завода таймера — старое ожидание обязано отмениться,
// иначе выстрелов будет два.
let staleFired = 0;
let staleNow = false;
// Панель домерила часы через 50 мс после завода — момент пересчитан, старое ожидание
// должно тихо умереть, не выстрелив.
setTimeout(() => {
  staleNow = true;
}, 50);
const cancelled = await shot.shootAt({
  localTargetMs: Date.now() + 500,
  count: 2,
  sendOne: () => {
    staleFired += 1;
    return { dryRun: true };
  },
  deps: { stale: () => staleNow },
});
check("отменённый выстрел не стреляет", cancelled.cancelled === true && staleFired === 0, `отправок ${staleFired}`);

// Живой код content.js: что делается заранее, а что в момент выстрела.
const contentLive = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
check('тело заявки готовится при заводе, а не в 00:00', /shotPlan\.bodyPrefix = prepareBody\(/.test(contentLive) && !/prepareBody\(/.test(contentLive.slice(contentLive.indexOf('function liveSend'), contentLive.indexOf('function deliverReport'))));
check('в момент выстрела берётся свежий токен, а не сохранённый', /const token = guardState\.token/.test(contentLive));
check('без токена заявка не уходит вовсе', /if \(!token\) return \{ skipped:/.test(contentLive));
check('страница взводит таймер сама — панель к полуночи закрыта', /setInterval\(maybeArm, 1000\)/.test(contentLive));
check('таймер взводится заранее, а не в последнюю секунду', /ARM_LEAD_MS = 15 \* 60 \* 1000/.test(contentLive));
check('право на подачу спрашивается до выстрела', contentLive.indexOf('claimShot(targetMs)') < contentLive.indexOf('shootAt({'));
// Повторов вслепую нет по-прежнему. Второй шанс (18.08) — не повтор: он открывается
// только когда сайт потребовал проверку, и стреляет только по действию человека.
check('повторов вслепую нет — ни цикла, ни счётчика попыток', !/подать ещё раз|retry|attempt\s*\+\+/i.test(contentLive));

// --- Проверка на робота В МОМЕНТ ОТПРАВКИ (18.08.2026) -----------------------
// Выяснилось живьём: Cloudflare просит проверку не только при открытии формы, но и на
// самой отправке. Значит, ночь проигрывается не отказом сайта, а тем, что заявка до него
// не дошла — и человек, сидящий перед этой же вкладкой, ещё может её спасти.
logger.info('--- Проверка на робота в момент отправки ---');

const cfHeader = { ok: true, result: { status: 200, text: '{"code":"500"}', headers: { 'cf-mitigated': 'challenge' } } };
check('челлендж узнаётся по заголовку Cloudflare, даже если тело похоже на ответ', outcome.readAnswer(cfHeader).kind === 'challenge');
const cf403 = { ok: true, result: { status: 403, text: '' } };
check('пустой 403 — тоже челлендж, а не молчание сайта', outcome.readAnswer(cf403).kind === 'challenge');
const cfBody = { ok: true, result: { status: 200, text: '<html><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></html>' } };
check('страница проверки узнаётся по телу', outcome.readAnswer(cfBody).kind === 'challenge');
const realReject = { ok: true, result: { status: 200, text: '{"code":"500","arr_date":"no_date"}' } };
check('настоящий отказ сайта челленджем не объявляется', outcome.readAnswer(realReject).kind === 'rejected', outcome.readAnswer(realReject).reason);
const realOk = { ok: true, result: { status: 200, text: '{"code":"201"}', headers: { 'cf-mitigated': '' } } };
check('принятая заявка не путается с проверкой', outcome.readAnswer(realOk).accepted === true);

const sumChal = outcome.summarize({ results: [cfHeader, cfHeader], booking: BOOKING });
check('оба места помечены как «ещё можно подать»', sumChal.needsHuman.length === 2 && sumChal.challenged === true);
check('итог зовёт пройти проверку, а не сообщает о поражении', /пройдите проверку/i.test(sumChal.text), sumChal.text);
const sumMix = outcome.summarize({ results: [answered('201'), cfHeader], booking: BOOKING });
check('доподать надо только непрошедшее место', sumMix.needsHuman.length === 1 && sumMix.needsHuman[0] === 1, JSON.stringify(sumMix.needsHuman));
check('уже принятое место видно и в этом случае', /Принято 1 из 2/.test(sumMix.text), sumMix.text);
const sumSkip = outcome.summarize({ results: [{ skipped: 'проверка на робота не пройдена — заявка не отправлена' }], booking: BOOKING });
check('непройденная проверка тоже даёт второй шанс', sumSkip.needsHuman.length === 1 && sumSkip.challenged === false);
const sumPlainFail = outcome.summarize({ results: [answered('500'), answered('500')], booking: BOOKING });
check('обычный отказ второго шанса не открывает', sumPlainFail.needsHuman.length === 0, JSON.stringify(sumPlainFail.needsHuman));
check('в отчёт наружу попадает сам факт проверки', outcome.reportBody({ outcome: sumChal, booking: BOOKING }).challenged === true);

// Порядок разбора: сайт умеет ругаться на САМО поле токена, и это честный JSON-отказ,
// а не страница проверки. Если перепутать — второй шанс откроется не там, где надо.
const tokenReject = { ok: true, result: { status: 200, text: '{"code":"500","cf-turnstile-response":"empty"}' } };
check('отказ по полю токена читается как отказ, а не как страница', outcome.readAnswer(tokenReject).kind === 'rejected', outcome.readAnswer(tokenReject).reason);
check('но второй шанс он всё равно открывает', outcome.readAnswer(tokenReject).needsHuman === true);
const plainReject = { ok: true, result: { status: 200, text: '{"code":"500","arr_date":"no_date"}' } };
check('отказ по дате второго шанса не открывает', !plainReject.needsHuman && outcome.readAnswer(plainReject).needsHuman !== true);

// Заголовки защиты обязаны доезжать до разбора — иначе `cf-mitigated` некому прочитать.
const withHeaders = await send.submitOnce({
  url: '/x/',
  body: 'a=1',
  deps: { fetch: () => Promise.resolve({ status: 403, text: () => Promise.resolve(''), headers: { get: (n) => (n === 'cf-mitigated' ? 'challenge' : '') } }) },
});
check('заголовки защиты доезжают до разбора', withHeaders.headers['cf-mitigated'] === 'challenge', JSON.stringify(withHeaders.headers));
check('челлендж по живому ответу опознан', outcome.readAnswer(withHeaders).kind === 'challenge');

// Рамки второго шанса. Он обязан остаться человеческим действием, а не долбёжкой:
// именно за долбёжку сайт отвечал `429` в ночь 07.08.
check('второй шанс тратится ровно один раз', /secondChance\.used = true;/.test(contentLive) && (contentLive.match(/secondChance\.used = true/g) || []).length === 1);
check('второй шанс не откроется дважды', /if \(!need\.length \|\| secondChance\.used\)/.test(contentLive));
check('без пройденной проверки второй шанс не стреляет', /if \(!guardState\.token\) return Promise\.resolve\(\{ ok: false/.test(contentLive));
check('второй шанс закрывается по времени, а не висит до утра', /SECOND_CHANCE_WINDOW_MS = 10 \* 60 \* 1000/.test(contentLive) && /Date\.now\(\) - secondChance\.since > SECOND_CHANCE_WINDOW_MS/.test(contentLive));
check('сам собой второй шанс срабатывает только на НОВЫЙ токен от человека', /guardState\.renewals <= secondChance\.renewalsAtShot\) return;/.test(contentLive));
check('доподаём только те места, что не прошли', /secondChance\.indexes\.map\(\(i\) =>/.test(contentLive));
check('после доподачи итог пересчитывается и уходит заново', /function refreshOutcome\(\)/.test(contentLive) && /deliverReport\(lastShot, secondChance\.booking\)/.test(contentLive));
check('расширение по-прежнему не проходит проверку за человека', !/turnstile\.(render|execute)|grecaptcha|\.click\(\)/.test(contentLive));

// Значок на кнопке — единственный способ докричаться при закрытой панели. Прав на
// уведомления при этом не появилось: значок доступен любому расширению с кнопкой.
const bgLive = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
check('значок зовёт человека, когда панель закрыта', /chrome\.action\.setBadgeText/.test(bgLive));
check('ради значка не попросили ни одного нового права', !Object.prototype.hasOwnProperty.call(manifest, 'permissions'));

// Панель: одна кнопка, и та лишь дублирует то, что страница сделает сама.
const popupLive = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
check('панель показывает просьбу пройти проверку', /renderSecond/.test(popupLive) && /Сайт просит проверку/.test(popupLive));
check('кнопка второго шанса ничего не отправляет сама', !/fetch\s*\(/.test(popupLive.slice(popupLive.indexOf("$('second-btn')"), popupLive.indexOf("$('copy-btn')"))));
check('панель не зовёт присылать фото, пока дело можно поправить', /if \(state\.secondChance && state\.secondChance\.waiting\) return null;/.test(popupLive));
for (const [what, id] of [['просьбы', 'second-text'], ['кнопки', 'second-btn']]) {
  check(`в панели есть блок ${what}`, popupHtml.includes(`id="${id}"`));
}

// --- Ночь целиком, без сайта и без браузера ----------------------------------
// Самый дорогой участок кода — тот, что работает ровно один раз в сутки, в полночь, и
// переспросить его нельзя. Поэтому прогоняем его здесь целиком: настоящий content.js со
// всеми своими библиотеками, поддельный DOM вместо страницы и подставной ответ вместо
// сайта. Проверяем то, что иначе выяснилось бы только живой ночью: сайт ответил
// проверкой на робота — расширение открыло второй шанс, человек прошёл проверку —
// заявка ушла заново и итог стал верным.
logger.info('--- Ночь целиком: челлендж, второй шанс, доподача ---');

function makeNight() {
  const tokenInput = { name: 'cf-turnstile-response', value: '' };
  const dom = {
    'input[name], select[name], textarea[name]': [{ name: 'type_person', value: 'fiz' }, { name: 'is_login', value: '1' }, tokenInput],
    'input[name], select[name]': [{ name: 'arr_date' }, { name: 'type_mesta' }, { name: 'assort_arr[]' }],
    'input[name]': [tokenInput],
    form: [{ id: 'form_reg' }],
    'script[src]': [],
    'iframe[src]': [{ src: 'https://challenges.cloudflare.com/turnstile/v0/api.js' }],
    '[class]': [],
    'input[name="cf-turnstile-response"]': tokenInput,
  };
  const timers = [];
  const sent = [];
  let fetchImpl = () => Promise.reject(new Error('запрос не ожидался'));
  const messages = [];

  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    Number,
    String,
    Object,
    Array,
    Boolean,
    RegExp,
    Error,
    Intl,
    URLSearchParams,
    AbortController,
    isNaN,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    clearInterval,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.push(id);
      return id;
    },
    fetch: (url, opts) => {
      sent.push({ url, opts });
      return fetchImpl(url, opts);
    },
    location: { href: 'https://gorod.it-minsk.by/rinki/minsk/reg/fiz/' },
    MutationObserver: class {
      observe() {}
    },
    document: {
      body: { innerText: 'Личный кабинет пользователя 3080000c000pb0 Выход' },
      documentElement: {},
      querySelectorAll: (sel) => (Array.isArray(dom[sel]) ? dom[sel] : []),
      querySelector: (sel) => (dom[sel] === undefined ? null : Array.isArray(dom[sel]) ? dom[sel][0] || null : dom[sel]),
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          messages.push(msg);
          if (cb) cb(msg.type === 'CLAIM_SHOT' ? { ok: true, granted: true } : { ok: true });
        },
        onMessage: { addListener: () => {} },
      },
    },
  };

  // Порядок файлов — тот же, что в манифесте: Chrome кладёт их в одну область видимости,
  // и здесь она тоже одна. Значит, проверяется в том числе и сам порядок подключения.
  const files = (manifest.content_scripts[0].js || []).map((rel) => fs.readFileSync(path.join(EXT, rel), 'utf8'));
  // content.js объявляет своё состояние через const/let: в vm они живут в лексической
  // области скрипта и на объекте песочницы не появляются. Достаём их явным хвостом.
  const tail = '\n;globalThis.__night = { guardState, secondChance, armShot, shot: () => lastShot };\n';
  vm.runInNewContext(files.join('\n;\n') + tail, sandbox, { filename: 'content-scripts.js' });

  return {
    sandbox,
    tokenInput,
    sent,
    messages,
    stop: () => timers.forEach((t) => clearInterval(t)),
    setFetch: (fn) => {
      fetchImpl = fn;
    },
  };
}

const night = makeNight();
const ctx = night.sandbox.__night;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Человек прошёл проверку до полуночи — токен в форме есть.
night.tokenInput.value = 'TOKEN-BEFORE-MIDNIGHT';
await wait(400);
check('расширение увидело пройденную проверку', ctx.guardState.token === 'TOKEN-BEFORE-MIDNIGHT', ctx.guardState.token);

// Полночь. Сайт отвечает не заявкой, а проверкой на робота — ровно то, что случилось 18.08.
night.setFetch(() =>
  Promise.resolve({
    status: 403,
    text: () => Promise.resolve('<html><head><title>Just a moment...</title></head></html>'),
    headers: { get: (n) => (n === 'cf-mitigated' ? 'challenge' : '') },
  }),
);
ctx.armShot(Date.now() + 150, 2);
await wait(900);

check('в полночь ушли обе заявки', night.sent.length === 2, `запросов ${night.sent.length}`);
check('заявка ушла с токеном, добытым человеком', String(night.sent[0].opts.body).includes('TOKEN-BEFORE-MIDNIGHT'));
check('ответ сайта опознан как проверка, а не как отказ', ctx.shot().outcome.challenged === true, ctx.shot().outcome.text);
check('второй шанс открыт на оба места', ctx.secondChance.waiting === true && ctx.secondChance.indexes.length === 2);
check('значок позвал человека', night.messages.some((m) => m.type === 'SET_BADGE' && m.kind === 'alert'));
check('итог зовёт пройти проверку', /Пройдите проверку/.test(ctx.shot().outcome.text), ctx.shot().outcome.text);

// Пока человек не пошевелился — ни одного лишнего запроса. Это и есть «не долбим сайт».
await wait(700);
check('без человека расширение молчит', night.sent.length === 2, `запросов ${night.sent.length}`);

// Человек прошёл проверку заново: виджет выдал НОВЫЙ токен. Теперь сайт принимает.
night.setFetch(() => Promise.resolve({ status: 200, text: () => Promise.resolve('{"code":"201"}'), headers: { get: () => '' } }));
night.tokenInput.value = 'TOKEN-SECOND-CHANCE';
await wait(1200);

check('доподача ушла сама, без единого нажатия', night.sent.length === 4, `запросов ${night.sent.length}`);
check('доподача несёт новый токен', String(night.sent[3].opts.body).includes('TOKEN-SECOND-CHANCE'));
check('итог пересчитан: места взяты', ctx.shot().outcome.ok === true && ctx.shot().outcome.acceptedCount === 2, ctx.shot().outcome.text);
check('в Telegram ушёл исправленный итог', night.messages.filter((m) => m.type === 'SEND_REPORT').length === 2);
check('значок сменился на «получилось»', night.messages.filter((m) => m.type === 'SET_BADGE').pop().kind === 'ok');

// Третьего шанса нет: ещё один новый токен ничего не отправляет.
night.tokenInput.value = 'TOKEN-THIRD';
await wait(900);
check('третьего шанса не бывает', night.sent.length === 4, `запросов ${night.sent.length}`);
night.stop();

// Та же ночь, но человек к клавиатуре не подошёл: окно закрывается само и молча.
const night2 = makeNight();
night2.setFetch(() =>
  Promise.resolve({ status: 403, text: () => Promise.resolve(''), headers: { get: (n) => (n === 'cf-mitigated' ? 'challenge' : '') } }),
);
night2.tokenInput.value = 'TOKEN-X';
await wait(400);
night2.sandbox.__night.armShot(Date.now() + 150, 2);
await wait(900);
check('без человека второй шанс просто ждёт', night2.sandbox.__night.secondChance.waiting === true && night2.sent.length === 2);
// Окно второго шанса — 10 минут; отматываем его, вместо того чтобы ждать вживую.
night2.sandbox.__night.secondChance.since -= 11 * 60 * 1000;
await wait(700);
check('через 10 минут второй шанс закрывается сам', night2.sandbox.__night.secondChance.waiting === false);
check('и всё равно ни одного лишнего запроса', night2.sent.length === 2, `запросов ${night2.sent.length}`);
night2.stop();

// --- Итог -------------------------------------------------------------------
if (failed) {
  logger.error(`Проверка не пройдена: ошибок ${failed}`);
  process.exit(1);
}
logger.info('Все проверки этапов ext-1…ext-6 пройдены (боевая подача ext-5 — код). Осталась живая: поставить в Chrome по ext/README.md.');
