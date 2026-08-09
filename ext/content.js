// Content script: живёт на странице подачи и по запросу панели рассказывает, что видит.
// Только чтение: ни одного запроса к сайту, ни одного изменения страницы. Правило вехи —
// расширение делает ровно то, что сделал бы человек, не больше.

const PAGE_OPENED_AT = Date.now();

// Все input/select формы в простой объект {name: value} — то же, что parseFormFields
// бота (src/site/order.js), только по живому DOM вместо HTML.
function collectFields() {
  const fields = {};
  for (const el of document.querySelectorAll('input[name], select[name], textarea[name]')) {
    if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
    fields[el.name] = el.value;
  }
  return fields;
}

// Приметы страницы подачи. По action судить нельзя — у формы брони его нет вовсе
// (адрес подставляет скрипт сайта), поэтому смотрим id формы и имена её полей.
function collectPageMarks() {
  return {
    formIds: Array.from(document.querySelectorAll('form')).map((f) => f.id || ''),
    inputNames: Array.from(document.querySelectorAll('input[name], select[name]')).map((el) => el.name),
  };
}

// Шапка страницы: «Личный кабинет пользователя <код>» и ссылка «Выход». Единственный
// признак входа, который сайт реально даёт — в саму форму он ФИО не подставляет.
function collectHeader() {
  return parseHeader(document.body ? document.body.innerText || '' : '');
}

// ——— Наблюдение за проверкой на робота (этап ext-2) ————————————————————————
//
// Токен виджет кладёт в скрытое поле, присваивая элементу свойство .value. MutationObserver
// такое присваивание НЕ видит (атрибут не меняется), поэтому за значением следим опросом
// раз в 300 мс, а observer нужен для другого — заметить появление самого поля/виджета.
// Опрос идёт по локальному DOM: к сайту не уходит ни одного запроса.

const guardState = {
  kind: null, // turnstile | recaptcha | hcaptcha | null
  widgetSeen: false, // виджет присутствует на странице
  fieldName: null, // имя поля, в котором лежит токен
  token: '', // сам токен (панели отдаём только длину, наружу не выносим)
  seenAt: null, // когда расширение увидело этот токен
  issuedKnown: true, // false = токен уже лежал в форме, когда мы начали смотреть
  renewals: 0, // сколько раз токен сменился (виджет обновляет его сам)
};

function guardSources() {
  return {
    scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.src),
    iframes: Array.from(document.querySelectorAll('iframe[src]')).map((f) => f.src),
    classes: Array.from(document.querySelectorAll('[class]')).flatMap((el) => Array.from(el.classList)),
    inputNames: Array.from(document.querySelectorAll('input[name]')).map((i) => i.name),
  };
}

function findTokenInput() {
  for (const name of TOKEN_FIELD_NAMES) {
    const el = document.querySelector(`input[name="${name}"]`);
    if (el) return el;
  }
  // Виджет мог назвать поле иначе — ищем по смыслу имени, как это делает разбор бота.
  return document.querySelector('input[name*="turnstile"], input[name*="captcha"], input[name*="challenge"]');
}

function pollGuard() {
  const sources = guardSources();
  guardState.kind = guardKindFromSources(sources);
  guardState.widgetSeen =
    !!document.querySelector('.cf-turnstile, .g-recaptcha, .h-captcha') ||
    sources.iframes.some((src) => /challenges\.cloudflare\.com|recaptcha|hcaptcha/i.test(src));

  const input = findTokenInput();
  guardState.fieldName = input ? input.name : null;
  const value = input ? String(input.value || '') : '';

  if (value !== guardState.token) {
    if (value) {
      // Первый непустой токен в первом же опросе = он мог быть выдан до открытия
      // страницы панелью: тогда срок годности считать не от чего, признаёмся в этом.
      const firstLook = guardState.seenAt === null && Date.now() - PAGE_OPENED_AT < 1500;
      guardState.issuedKnown = !firstLook;
      if (guardState.token) guardState.renewals += 1;
      guardState.seenAt = Date.now();
    } else {
      guardState.seenAt = null;
      guardState.issuedKnown = true;
    }
    guardState.token = value;
  }
}

pollGuard();
setInterval(pollGuard, 300);
// Виджет и его поле появляются не сразу — замечаем это без ожидания следующего опроса.
new MutationObserver(pollGuard).observe(document.documentElement, { childList: true, subtree: true });

// ——— Что именно подавать (этап ext-3) ————————————————————————————————————
//
// Тип места и ассортимент берём СО СТРАНИЦЫ, если человек их выбрал, и только иначе
// подставляем константы кабинета. Так расширение подаёт то же, что подал бы человек
// руками, а не то, что мы когда-то вписали в код.

function readOrderInputs() {
  const typeEl = document.querySelector('select[name*="type_mest" i], input[name*="type_mest" i]:checked');
  const typeMesta = typeEl && typeEl.value ? Number(typeEl.value) : TYPE_MESTA_DEFAULT;

  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"][name*="assort" i]:checked'))
    .map((el) => Number(el.value))
    .filter((v) => Number.isFinite(v));
  const assortIds = boxes.length ? boxes : ASSORT_DEFAULT;

  return { typeMesta, assortIds, fromPage: { type: !!typeEl, assort: boxes.length > 0 } };
}

function buildPlan(fields, account, booking) {
  const inputs = readOrderInputs();
  const payload = buildCreateZajavPayload({
    fields,
    rinokId: RINOK_ID,
    typeMesta: inputs.typeMesta,
    day: booking.day,
    month: booking.month,
    year: booking.year,
    assortIds: inputs.assortIds,
  });
  return {
    // С этапа ext-5 подача боевая. dryRun остаётся ради разработчика (config.js) и ради
    // тренировочного залпа в ext/dev/preview.html — клиентке этот флаг не показывается.
    dryRun: !LIVE_SUBMIT,
    count: BOOKINGS_PER_ACCOUNT,
    typeMesta: inputs.typeMesta,
    assortIds: inputs.assortIds,
    fromPage: inputs.fromPage,
    text: describePlan({ count: BOOKINGS_PER_ACCOUNT, booking, assortIds: inputs.assortIds }),
    problems: planProblems({
      account,
      day: booking.day,
      hasToken: !!guardState.token,
      tokenField: guardState.fieldName || (guardState.kind ? TOKEN_FIELD_NAMES[0] : null),
    }),
    // Панели уходит предпросмотр тела с длиной токена вместо самого токена.
    preview: previewForm(payload, guardState.fieldName, guardState.token.length),
  };
}

// ——— Часы и выстрел (этап ext-4) ——————————————————————————————————————————
//
// Сеть на странице сайта расширению по-прежнему недоступна: замер часов делает панель
// (clocksync.js, к сайту не ходит) и присылает сюда готовую поправку. Здесь она только
// хранится и учитывается в момент выстрела.

const clockState = {
  sync: null, // результат замера от панели
  offsetMs: 0, // применяемая поправка (мелкую и шумную не применяем)
};

let lastShot = null;
let armedFor = null; // на какой момент взведён таймер по часам ЭТОГО компьютера
let lastArmTargetMs = null; // та же цель в настоящем времени (для пересчёта поправки)
let armGen = 0; // поколение завода: старое ожидание отменяется, когда момент пересчитан

// Тренировочная отправка: ничего не уходит, только отметка, что до неё дошло дело.
// Живёт для разработчика (LIVE_SUBMIT=false) и для предпросмотра панели.
function dryRunSend(index) {
  return { dryRun: true, index, at: Date.now() };
}

// ——— Боевая подача (этап ext-5) ——————————————————————————————————————————
//
// Всё, что можно сделать заранее, делается при заводе таймера: тело заявки собрано,
// право на подачу получено. В 00:00:00.000 остаётся приклеить свежий токен и вызвать
// fetch — один раз на место, без единой повторной попытки.

const shotPlan = {
  bodyPrefix: null, // готовое тело без токена
  url: null,
  claimed: null, // право на подачу: эта вкладка стреляет, остальные молчат
};

// За сколько до полуночи расширение само взводит таймер. Панель к этому времени может
// быть уже закрыта — она всплывающая и живёт, только пока на неё смотрят, поэтому
// стрелять обязан content script, а не она.
var ARM_LEAD_MS = 15 * 60 * 1000;
// За сколько до выстрела спрашиваем право на подачу. Не при заводе: фоновый скрипт
// Chrome засыпает через полминуты простоя и просыпается с пустой памятью — спрашивать
// надо тогда, когда все вкладки спросят почти одновременно и решать будет один и тот же
// проснувшийся экземпляр.
var CLAIM_LEAD_MS = 5000;

// Право на подачу. Две открытые вкладки формы = два content script'а, и без этого они
// подали бы по 2 заявки каждая: лимит кабинета 2 места в сутки, лишние заявки — отказ
// и риск нарваться на ограничение частоты (429 ловили живьём 07.08).
//
// Молчание фонового скрипта трактуем как «право есть»: пропустить ночь хуже, чем
// отправить лишнюю заявку.
function claimShot(targetMs) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'CLAIM_SHOT', targetMs }, (res) => {
        void chrome.runtime.lastError;
        resolve(!res || res.granted !== false);
      });
    } catch (e) {
      resolve(true);
    }
  });
}

// Одна боевая заявка. Вызывается в момент выстрела и обязана быть предельно короткой.
function liveSend(index) {
  if (!LIVE_SUBMIT) return dryRunSend(index);
  if (shotPlan.claimed === false) return { skipped: 'подача идёт в другой вкладке — эта промолчала' };
  const token = guardState.token;
  const field = guardState.fieldName || TOKEN_FIELD_NAMES[0];
  // Без токена сервер отклонит заявку на валидации (это и есть блокер 04.08) — слать
  // такое бессмысленно, а человеку нужна причина словами, а не код 500.
  if (!token) return { skipped: 'проверка на робота не пройдена — заявка не отправлена' };
  return submitOnce({
    url: shotPlan.url,
    body: bodyWithToken(shotPlan.bodyPrefix, field, token),
  });
}

// Отчёт о ночи фоновому скрипту, а он — нашему серверу (ext-6). Вторичен по отношению
// к подаче: вызывается ПОСЛЕ залпа, ничего не ждёт и не умеет сорвать заявку. Даже если
// интернет отвалился или сервер лежит, здесь всё закончится записью в lastReport.
let lastReport = null;

function deliverReport(report, booking) {
  const body = reportBody({
    outcome: report.outcome,
    account: accountFromFields(collectFields(), collectHeader()),
    booking,
    now: Date.now(),
  });
  lastReport = { at: Date.now(), sent: false, ok: false, error: null };
  try {
    chrome.runtime.sendMessage({ type: 'SEND_REPORT', body }, (res) => {
      void chrome.runtime.lastError;
      lastReport = {
        at: Date.now(),
        sent: true,
        ok: !!(res && res.ok),
        error: res && res.error ? res.error : chrome.runtime.lastError ? 'фоновый скрипт не ответил' : null,
      };
    });
  } catch (e) {
    lastReport = { at: Date.now(), sent: true, ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function armShot(targetMs, count) {
  const local = localTargetMs(targetMs, clockState.offsetMs);
  if (armedFor === local) return { ok: true, already: true, localTargetMs: local };
  if (local - Date.now() <= 0) return { ok: false, error: 'момент уже прошёл' };

  armedFor = local;
  lastArmTargetMs = targetMs;
  armGen += 1;
  const gen = armGen;
  // Дату брони фиксируем ПРИ ЗАВОДЕ: после полуночи «ближайшая ночь» становится
  // следующей, и итог рассказывал бы про завтрашнюю дату вместо только что поданной.
  const bookingAtArm = bookingDateFor(nextRegistrationMidnight());

  // Тело заявки готовим здесь, за минуты до выстрела. В 00:00:00.000 к нему добавится
  // только токен: сборка payload в момент залпа стоила бы миллисекунд на ровном месте.
  const inputs = readOrderInputs();
  const payload = buildCreateZajavPayload({
    fields: collectFields(),
    rinokId: RINOK_ID,
    typeMesta: inputs.typeMesta,
    day: bookingAtArm.day,
    month: bookingAtArm.month,
    year: bookingAtArm.year,
    assortIds: inputs.assortIds,
  });
  shotPlan.bodyPrefix = prepareBody(payload);
  shotPlan.url = CREATE_PATH; // свой же origin, кука страницы уезжает вместе с запросом
  shotPlan.claimed = null;
  setTimeout(
    () => {
      if (gen !== armGen) return;
      claimShot(targetMs).then((granted) => {
        if (gen === armGen) shotPlan.claimed = granted;
      });
    },
    Math.max(0, local - Date.now() - CLAIM_LEAD_MS),
  );

  shootAt({
    localTargetMs: local,
    offsetMs: clockState.offsetMs,
    count: count || BOOKINGS_PER_ACCOUNT,
    sendOne: LIVE_SUBMIT ? liveSend : dryRunSend,
    deps: { stale: () => gen !== armGen },
  }).then((report) => {
    if (report.cancelled) return; // момент пересчитали — стреляет уже другой завод
    report.dryRun = !LIVE_SUBMIT;
    report.targetMs = targetMs;
    // Итог считаем СРАЗУ после залпа и кладём в состояние: панель забирает его следующим
    // же опросом (раз в секунду), поэтому «принято 2 из 2» видно без обновления страницы.
    report.outcome = summarize({ results: report.results, booking: bookingAtArm, shot: report });
    lastShot = report;
    armedFor = null;
    deliverReport(report, bookingAtArm);
  });

  return { ok: true, localTargetMs: local, inMs: local - Date.now() };
}

// Самозавод. Панель — всплывающая: она закрывается, как только человек щёлкнул мимо, и
// вместе с ней умер бы любой таймер, заведённый в ней. Поэтому за полночь отвечает
// страница: она открыта до утра («не закрывайте вкладку»), и в 23:45 сама берёт цель.
function maybeArm() {
  if (armedFor !== null) return;
  const target = nextRegistrationMidnight();
  if (target.ms - Date.now() > ARM_LEAD_MS) return;
  // Не та страница или кабинет не виден — заводить нечего: подавать не от кого.
  const state = readState();
  if (!state.readiness.ok) return;
  armShot(target.ms, BOOKINGS_PER_ACCOUNT);
}

setInterval(maybeArm, 1000);
maybeArm();

// ——— Ответ панели ————————————————————————————————————————————————————————

function readState() {
  const fields = collectFields();
  const account = accountFromFields(fields, collectHeader());
  const onSubmitPage = isSubmitPage(location.href, collectPageMarks());
  const target = nextRegistrationMidnight();
  const booking = bookingDateFor(target);

  const status = tokenStatus({
    token: guardState.token,
    seenAt: guardState.seenAt,
    issuedKnown: guardState.issuedKnown,
    targetMs: target.ms,
  });
  const advice = guardAdvice({
    kind: guardState.kind,
    widgetSeen: guardState.widgetSeen,
    status,
    targetMs: target.ms,
    pageAgeMs: Date.now() - PAGE_OPENED_AT,
  });

  const state = {
    onSubmitPage,
    account,
    target,
    booking,
    plan: buildPlan(fields, account, booking),
    url: location.href,
    readAt: Date.now(),
    guard: {
      kind: guardState.kind,
      widgetSeen: guardState.widgetSeen,
      fieldName: guardState.fieldName,
      // Сам токен панели не нужен — только факт, длина и время. Меньше поводов его утечь.
      hasToken: !!guardState.token,
      tokenLength: guardState.token.length,
      seenAt: guardState.seenAt,
      issuedKnown: guardState.issuedKnown,
      renewals: guardState.renewals,
      status,
      advice,
    },
    clock: {
      sync: clockState.sync,
      offsetMs: clockState.offsetMs,
      verdict: clockVerdict(clockState.sync),
      // В какой момент по часам ЭТОГО компьютера наступит настоящая полночь.
      localTargetMs: localTargetMs(target.ms, clockState.offsetMs),
    },
    shot: lastShot,
    outcome: lastShot ? lastShot.outcome || null : null,
    report: lastReport,
    armedFor,
  };
  state.readiness = readiness(state);
  return state;
}

// Панель спрашивает — content script отвечает. Если content script на странице не
// запущен (значит, страница посторонняя), sendMessage просто не получит ответа —
// панель это и покажет. Никакого фонового скрипта для этого не нужно.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg && msg.type === 'GET_STATE') {
      sendResponse({ ok: true, state: readState() });
    } else if (msg && msg.type === 'SET_CLOCK') {
      // Поправку меряет панель, применяем её здесь: мелкую и шумную отбрасываем,
      // чтобы не двигать выстрел по случайному джиттеру сети.
      clockState.sync = msg.sync || null;
      clockState.offsetMs = usableOffset(msg.sync);
      // Таймер мог быть заведён до замера — тогда он целится по часам ПК. Переназначаем
      // момент: старое ожидание отменится само (см. stale в lib/shot.js).
      if (armedFor !== null && lastArmTargetMs != null) {
        const fresh = localTargetMs(lastArmTargetMs, clockState.offsetMs);
        if (Math.abs(fresh - armedFor) > 1) {
          armedFor = null;
          armGen += 1; // отменяем старое ожидание, чтобы оно не выстрелило вторым залпом
          armShot(lastArmTargetMs, BOOKINGS_PER_ACCOUNT);
        }
      }
      sendResponse({ ok: true, offsetMs: clockState.offsetMs });
    } else if (msg && msg.type === 'ARM_SHOT') {
      sendResponse({ ok: true, armed: armShot(msg.targetMs, msg.count) });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  }
  return false; // ответ синхронный
});
