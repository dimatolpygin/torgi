// Панель. Спрашивает content script активной вкладки и рисует, что тот увидел.
// Обратный отсчёт идёт по часам ПК — на этих этапах этого достаточно; сверка часов
// с сервером и точный выстрел — этап ext-4.

const $ = (id) => document.getElementById(id);

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
  if (target.ms - Date.now() <= 0) {
    // Полночь прошла, пока панель открыта — пересчитываем цель на следующую ночь.
    target = nextRegistrationMidnight();
  }
  $('countdown').textContent = formatCountdown(target.ms - Date.now());
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
  const st = tokenStatus({ token: 'x', seenAt: g.seenAt, issuedKnown: g.issuedKnown, targetMs: target.ms });
  const at = formatTimeRu(g.seenAt);
  el.textContent = st.state === 'expired' ? `истёк (был в ${at})` : `${at}, годен ${formatLeft(st.leftMs)}`;
  el.classList.toggle('bad', st.state !== 'valid' || !st.coversTarget);
  el.classList.toggle('ok', st.state === 'valid' && st.coversTarget);
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

async function main() {
  tick();
  setInterval(tick, 250);

  const tab = await activeTab();
  tabId = tab && tab.id != null ? tab.id : null;
  await refresh();
  // Раз в секунду перечитываем страницу: человек проходит проверку при открытой панели
  // и должен увидеть это сразу, не закрывая и не открывая её заново.
  setInterval(refresh, 1000);
}

main();
