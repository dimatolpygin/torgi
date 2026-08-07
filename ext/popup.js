// Панель. Спрашивает content script активной вкладки и рисует, что тот увидел.
// Здесь же (и только здесь) живёт единственный сетевой запрос расширения — замер
// расхождения часов ПК с настоящим временем; к сайту брони он не идёт (clocksync.js).

const $ = (id) => document.getElementById(id);

// Поправка часов: сколько миллисекунд прибавить к Date.now(), чтобы получить настоящее
// время. Меряется один раз при открытии панели и уходит в content script.
let clockSync = null;
let clockOffset = 0;
const trueNow = () => Date.now() + clockOffset;

function setStatus(kind, text) {
  const el = $('status');
  el.className = `status status-${kind}`;
  el.textContent = text;
}

// Отсчёт живёт независимо от вкладки: даже если страница подачи не открыта,
// человек видит, сколько осталось до полуночи.
let target = nextRegistrationMidnight();
let tabId = null;
let lastState = null;

function tick() {
  if (target.ms - trueNow() <= 0) {
    // Полночь прошла, пока панель открыта — пересчитываем цель на следующую ночь.
    target = nextRegistrationMidnight();
  }
  // Отсчёт идёт по НАСТОЯЩЕМУ времени: если часы ПК сбиты, человек должен видеть правду,
  // а не то же враньё, по которому он и так смотрит на часы в углу экрана.
  $('countdown').textContent = formatCountdown(target.ms - trueNow());
  $('target').textContent = `подача в 00:00, ночь на ${formatDateRu(target)}`;
  renderToken(); // остаток годности токена должен таять на глазах, а не при открытии
}

// Строка «Проверка на робота»: когда токен получен и сколько ему осталось жить.
// Пересчитывается локально каждый тик — момент выдачи известен, ходить за ним не нужно.
function renderToken() {
  const el = $('token');
  const g = lastState && lastState.guard;
  if (!g) {
    el.textContent = '—';
    el.classList.remove('bad', 'ok');
    return;
  }
  if (!g.hasToken) {
    el.textContent = g.widgetSeen ? 'не пройдена' : 'виджета нет';
    el.classList.add('bad');
    el.classList.remove('ok');
    return;
  }
  // Токен увидел content script по часам ПК, а цель (полночь) — в настоящем времени.
  // Приводим момент выдачи к настоящему, иначе сбитые часы исказят срок годности.
  const st = tokenStatus({
    token: 'x',
    seenAt: g.seenAt + clockOffset,
    issuedKnown: g.issuedKnown,
    targetMs: target.ms,
    now: trueNow(),
  });
  const at = formatTimeRu(g.seenAt + clockOffset);
  el.textContent = st.state === 'expired' ? `истёк (был в ${at})` : `${at}, годен ${formatLeft(st.leftMs)}`;
  el.classList.toggle('bad', st.state !== 'valid' || !st.coversTarget);
  el.classList.toggle('ok', st.state === 'valid' && st.coversTarget);
}

// Строка «Часы компьютера»: расхождение с настоящим временем и что мы с ним сделали.
function renderClock() {
  const el = $('clock');
  const v = clockVerdict(clockSync);
  const detail = clockSync && clockSync.ok ? ` (${clockSync.source}, дорога ${Math.round(clockSync.rttMs)} мс)` : '';
  el.textContent = v.text + detail;
  el.classList.toggle('bad', v.level !== 'ok');
  el.classList.toggle('ok', v.level === 'ok');
}

// Итог последнего тренировочного залпа: точность и одномоментность.
function renderShot(shot) {
  const el = $('drill-result');
  if (!shot) {
    el.textContent = '';
    return;
  }
  el.textContent = `${formatTimeRu(shot.atTrueMs)} — ${shot.text}`;
  const good = Math.abs(shot.driftMs) <= 50 && shot.parallel;
  el.classList.toggle('bad', !good);
  el.classList.toggle('ok', good);
}

// Итог ночи. Приходит из content script вместе с остальным состоянием (опрос раз в
// секунду), поэтому появляется сам — обновлять страницу не нужно.
function renderOutcome(state) {
  const box = $('outcome');
  const o = state && state.outcome;
  if (!o) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  $('outcome-text').textContent = o.text;
  box.classList.toggle('bad', !o.ok && !o.drill);
  box.classList.toggle('ok', !!o.ok);

  const r = state.report;
  const el = $('outcome-report');
  if (!r) el.textContent = '';
  else if (!r.sent) el.textContent = 'Отчёт в Telegram: отправляю…';
  else if (r.ok) el.textContent = 'Отчёт в Telegram отправлен.';
  else el.textContent = `Отчёт в Telegram не ушёл (${r.error || 'причина неизвестна'}) — на саму подачу это не влияет.`;
}

// Настройки доставки. Секрета в коде нет: человек вводит его один раз, лежит он в
// хранилище этого компьютера.
function storageGet(keys) {
  return new Promise((resolve) => {
    if (!(chrome.storage && chrome.storage.local)) return resolve({});
    chrome.storage.local.get(keys, (v) => {
      void chrome.runtime.lastError;
      resolve(v || {});
    });
  });
}

async function loadReportSettings() {
  const v = await storageGet(['reportUrl', 'reportSecret']);
  $('rep-url').value = v.reportUrl || '';
  // Само значение секрета в поле не возвращаем — показываем, что оно задано.
  $('rep-secret').placeholder = v.reportSecret ? 'задано (введите заново, чтобы сменить)' : 'длинная строка от разработчика';
  showReportState({ url: v.reportUrl || '', secret: v.reportSecret || '' });
}

function showReportState(s) {
  const problems = reportSettingsProblems(s);
  const el = $('rep-state');
  el.textContent = problems.length ? `Итог в Telegram пока не уйдёт: ${problems.join('; ')}` : 'Готово — итог уйдёт в Telegram сам.';
  el.classList.toggle('bad', problems.length > 0);
  el.classList.toggle('ok', problems.length === 0);
}

async function saveReportSettings() {
  const url = $('rep-url').value.trim();
  const secret = $('rep-secret').value;
  const current = await storageGet(['reportSecret']);
  // Пустое поле секрета = «не менять»: чтобы правка адреса не стирала уже введённое слово.
  const nextSecret = secret || current.reportSecret || '';
  const problems = reportSettingsProblems({ url, secret: nextSecret });
  if (problems.length) return showReportState({ url, secret: nextSecret });

  // Право на посторонний адрес спрашиваем у человека и только по его нажатию: в манифесте
  // оно необязательное, поэтому расширение по умолчанию никуда, кроме сайта брони, не ходит.
  if (chrome.permissions && chrome.permissions.request) {
    const origin = `${new URL(url).origin}/*`;
    const granted = await new Promise((resolve) => chrome.permissions.request({ origins: [origin] }, (g) => resolve(!!g)));
    if (!granted) {
      $('rep-state').textContent = 'Без разрешения на этот адрес отчёт отправить нельзя.';
      $('rep-state').classList.add('bad');
      return;
    }
  }
  chrome.storage.local.set({ reportUrl: url, reportSecret: nextSecret }, () => void chrome.runtime.lastError);
  $('rep-secret').value = '';
  $('rep-secret').placeholder = 'задано (введите заново, чтобы сменить)';
  showReportState({ url, secret: nextSecret });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function askState(id) {
  // Посторонняя страница = content script не внедрён, ответа не будет. Ошибку
  // chrome.runtime.lastError гасим намеренно: это не сбой, а «не та вкладка».
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(id, { type: 'GET_STATE' }, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

// Что уйдёт в полночь: фраза человеку, список помех и свёрнутый предпросмотр запроса.
function renderPlan(plan) {
  const box = $('plan');
  if (!plan) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  $('plan-text').textContent = plan.text;
  $('plan-preview').textContent = plan.preview;

  const list = $('plan-problems');
  list.textContent = '';
  for (const p of plan.problems) {
    const li = document.createElement('li');
    li.textContent = p;
    list.appendChild(li);
  }
}

function render(state) {
  lastState = state;
  const booking = state ? state.booking : bookingDateFor(target);
  $('booking').textContent = `${formatDateRu(booking)} (${booking.dateStr})`;

  if (!state) {
    $('account').textContent = 'страница не открыта';
    $('advice').textContent = '';
    setStatus('wait', 'Откройте в этой вкладке форму брони на gorod.it-minsk.by');
    renderToken();
    renderPlan(null);
    renderShot(null);
    renderOutcome(null);
    return;
  }

  const acc = state.account;
  $('account').textContent = acc.loggedIn ? shortFio(acc) : 'не вижу';

  const r = state.readiness;
  if (!r.ok) {
    setStatus('bad', r.text);
    $('advice').textContent = '';
  } else {
    // Страница и кабинет в порядке — главным в панели становится проверка на робота:
    // именно она решает, уйдёт ли заявка в полночь.
    const a = state.guard.advice;
    setStatus(a.level === 'ok' ? 'ok' : a.level === 'bad' ? 'bad' : 'wait', a.text);
    $('advice').textContent = `Кабинет: ${acc.fio}`;
  }
  renderToken();
  renderPlan(state.plan);
  renderShot(state.shot);
  renderOutcome(state);
}

async function refresh() {
  if (tabId == null) return;
  const res = await askState(tabId);
  if (res && res.ok) render(res.state);
  else if (res && !res.ok) {
    render(null);
    setStatus('bad', `Не смог прочитать страницу: ${res.error}`);
  } else render(null);
}

// Замер часов и передача поправки на страницу. Один раз за открытие панели: чаще незачем,
// а лишние запросы — лишний шум.
async function measureClock() {
  renderClock();
  clockSync = await syncClock();
  clockOffset = usableOffset(clockSync);
  renderClock();
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'SET_CLOCK', sync: clockSync }, () => void chrome.runtime.lastError);
  }
}

// Тренировочный залп: та же машинерия, что уйдёт в полночь, но по ближайшей ровной
// минуте и с заглушкой вместо отправки. Заводит его content script — он переживает
// закрытие панели, а панель бы не пережила.
function armDrill() {
  if (tabId == null) return;
  const at = nextRoundMinute(trueNow());
  $('drill-result').textContent = `взведён на ${formatTimeRu(at)} — ждём`;
  $('drill-result').classList.remove('bad', 'ok');
  chrome.tabs.sendMessage(tabId, { type: 'ARM_SHOT', targetMs: at, count: 2 }, (res) => {
    void chrome.runtime.lastError;
    if (!res || !res.ok) $('drill-result').textContent = 'страница подачи не открыта — залп заводить негде';
  });
}

async function main() {
  tick();
  setInterval(tick, 250);

  const tab = await activeTab();
  tabId = tab && tab.id != null ? tab.id : null;
  $('drill-btn').addEventListener('click', armDrill);
  $('rep-save').addEventListener('click', saveReportSettings);
  await loadReportSettings();
  await refresh();
  await measureClock();
  // Раз в секунду перечитываем страницу: человек проходит проверку при открытой панели
  // и должен увидеть это сразу, не закрывая и не открывая её заново.
  setInterval(refresh, 1000);
}

main();
