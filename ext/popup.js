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
  await refresh();
  await measureClock();
  // Раз в секунду перечитываем страницу: человек проходит проверку при открытой панели
  // и должен увидеть это сразу, не закрывая и не открывая её заново.
  setInterval(refresh, 1000);
}

main();
