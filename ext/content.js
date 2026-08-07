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
    // dryRun здесь всегда true: отправлять расширение пока не умеет вовсе — на странице
    // сайта у него нет ни одного fetch/XHR. Боевой режим появится отдельным этапом (ext-5).
    dryRun: true,
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

// Последний залп: что получилось. На этом этапе залп всегда тренировочный — вместо
// отправки подставлена заглушка, ни одного запроса к сайту не происходит.
let lastShot = null;
let armedFor = null; // на какой момент взведён таймер (защита от двойного завода)

// Заглушка отправки. В ext-5 сюда придёт настоящий fetch с токеном; сейчас она только
// фиксирует, что до неё дошло дело.
function dryRunSend(index) {
  return { dryRun: true, index, at: Date.now() };
}

function armShot(targetMs, count) {
  const local = localTargetMs(targetMs, clockState.offsetMs);
  if (armedFor === local) return { ok: true, already: true, localTargetMs: local };
  if (local - Date.now() <= 0) return { ok: false, error: 'момент уже прошёл' };

  armedFor = local;
  shootAt({
    localTargetMs: local,
    offsetMs: clockState.offsetMs,
    count: count || BOOKINGS_PER_ACCOUNT,
    sendOne: dryRunSend,
  }).then((report) => {
    report.dryRun = true;
    report.targetMs = targetMs;
    lastShot = report;
    armedFor = null;
  });

  return { ok: true, localTargetMs: local, inMs: local - Date.now() };
}

// ——— Ответ панели ————————————————————————————————————————————————————————

function readState() {
  const fields = collectFields();
  const account = accountFromFields(fields);
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
      sendResponse({ ok: true, offsetMs: clockState.offsetMs });
    } else if (msg && msg.type === 'ARM_SHOT') {
      sendResponse({ ok: true, armed: armShot(msg.targetMs, msg.count) });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  }
  return false; // ответ синхронный
});
