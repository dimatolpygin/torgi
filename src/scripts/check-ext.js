// UAT-скрипт этапа ext-1: каркас расширения Chrome.
// Офлайн: проверяет манифест, наличие и синтаксис файлов и логику библиотек
// (минское время, распознавание кабинета). В сеть не ходит, Chrome не нужен.
// Запуск: node src/scripts/check-ext.js
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
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
function loadLib(rel) {
  const code = fs.readFileSync(path.join(EXT, rel), 'utf8');
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Intl, Date, console });
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

for (const rel of ['lib/minsk.js', 'lib/account.js', 'content.js', 'popup.js']) {
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
for (const src of ['lib/minsk.js', 'lib/account.js', 'popup.js', 'popup.css']) {
  check(`popup.html подключает ${src}`, popupHtml.includes(src));
}

// Превью (ext/dev/preview.html) — панель без Chrome и без сайта, для разработки и показа.
// Оно рисуется тем же popup.js, поэтому обязано иметь те же id: разъедутся — превью
// начнёт врать, а заметить это будет нечем.
const ids = (html) => [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).sort();
const previewHtml = fs.readFileSync(path.join(EXT, 'dev', 'preview.html'), 'utf8');
check('превью использует ту же разметку, что панель', JSON.stringify(ids(previewHtml)) === JSON.stringify(ids(popupHtml)), ids(popupHtml).join(', '));
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

// --- Итог -------------------------------------------------------------------
if (failed) {
  logger.error(`Проверка не пройдена: ошибок ${failed}`);
  process.exit(1);
}
logger.info('Все проверки этапа ext-1 пройдены. Осталась живая: поставить в Chrome по ext/README.md.');
