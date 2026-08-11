// Панель. Одно правило: человек, который её открыл, должен за три секунды понять, надо
// ли ему что-то делать. Всё, что нужно разработчику и не нужно ему (предпросмотр запроса,
// тренировочный залп, адреса серверов, миллисекунды сети), из панели убрано — залп живёт
// в ext/dev/preview.html, настройки в config.js.
//
// Здесь же (и только здесь) единственный сетевой запрос расширения — сверка часов.

const $ = (id) => document.getElementById(id);

// Поправка часов: сколько миллисекунд прибавить к Date.now(), чтобы получить настоящее
// время. Меряется один раз при открытии панели и уходит в content script.
let clockSync = null;
let clockOffset = 0;
const trueNow = () => Date.now() + clockOffset;

let target = nextRegistrationMidnight();
let tabId = null;
let lastState = null;

function setStatus(kind, text) {
  const el = $('status');
  el.className = `status status-${kind}`;
  el.textContent = text;
}

// Отсчёт живёт независимо от вкладки: даже если страница подачи не открыта,
// человек видит, сколько осталось до полуночи.
function tick() {
  if (target.ms - trueNow() <= 0) target = nextRegistrationMidnight();
  // Считаем по НАСТОЯЩЕМУ времени: если часы ПК сбиты, человек должен видеть правду.
  $('countdown').textContent = formatCountdown(target.ms - trueNow());
  $('target').textContent = `подача в 00:00, ночь на ${formatDateRu(target)}`;
}

// Часы показываем, только когда с ними что-то не так настолько, что человеку стоит
// вмешаться. Поправку в 40 мс он всё равно не осмыслит, а место в панели она займёт.
function renderClock() {
  const el = $('clock-warn');
  const bad = clockSync && clockSync.ok && Math.abs(clockSync.offsetMs) > CLOCK_WARN_MS;
  if (!bad) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const off = Math.round(clockSync.offsetMs);
  el.textContent = `Часы компьютера ${off > 0 ? 'отстают' : 'спешат'} на ${(Math.abs(off) / 1000).toFixed(1)} с. Подача всё равно уйдёт вовремя, но часы лучше синхронизировать.`;
}

// Одна фраза о том, что уйдёт в полночь.
function renderPlan(plan) {
  const box = $('plan');
  if (!plan) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  $('plan-text').textContent = plan.text;
}

function renderOutcome(state) {
  const box = $('outcome');
  const o = state && state.outcome;
  if (!o) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  $('outcome-text').textContent = o.text;
  box.classList.toggle('bad', !o.ok);
  box.classList.toggle('ok', !!o.ok);
}

// Что-то пошло не так. Показываем ОДНУ просьбу и ОДНУ кнопку — человеку не нужно
// понимать причину, ему нужно знать, что делать. Разбираться будем по картинке.
//
// Блок появляется в трёх случаях: страница/кабинет не в порядке, проверка на робота
// упёрлась, ночь закончилась неудачей. В остальное время его нет вовсе.
function troubleReason(state) {
  if (!state) return 'Расширение не видит страницу брони.';
  if (!state.readiness.ok) return state.readiness.text + '.';
  if (state.outcome && !state.outcome.ok && !state.outcome.drill) return 'Заявку не приняли.';
  if (state.guard.advice.level === 'bad') return state.guard.advice.text + '.';
  return null;
}

function renderTrouble(state) {
  const box = $('trouble');
  const reason = troubleReason(state);
  if (!reason) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  $('trouble-text').textContent = `${reason} Сфотографируйте это окно целиком и пришлите — так я пойму, что случилось.`;
}

var NL = String.fromCharCode(10);

// Текст для пересылки. Пишем словами, без внутренностей: человек его увидит и должен
// понимать, что именно отправляет. Токена, куки и пароля здесь нет.
function troubleReport(state) {
  const rows = [
    `Время: ${new Date().toLocaleString('ru-RU')}`,
    `До подачи: ${formatCountdown(target.ms - trueNow())}`,
    `Ночь на: ${formatDateRu(target)}`,
  ];
  if (!state) {
    rows.push('Страница брони не открыта или не отвечает.');
    return rows.join(NL);
  }
  rows.push(`Кабинет: ${state.account && state.account.loggedIn ? accountLabel(state.account) : 'не виден'}`);
  rows.push(`Проверка на робота: ${state.guard.hasToken ? 'пройдена' : 'не пройдена'}`);
  rows.push(`Что показывает панель: ${state.readiness.ok ? state.guard.advice.text : state.readiness.text}`);
  if (state.outcome) rows.push(`Итог: ${state.outcome.text}`);
  if (state.shot) rows.push(`Выстрел: ${state.shot.text}`);
  return rows.join(NL);
}

// Внизу мелким: в каком кабинете сидим. Нужно ровно для одного — не перепутать профиль
// Chrome жены с профилем мужа.
function renderAccount(state) {
  const el = $('account');
  const acc = state && state.account;
  el.textContent = acc && acc.loggedIn ? `Кабинет: ${accountLabel(acc)}` : '';
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

function render(state) {
  lastState = state;

  if (!state) {
    setStatus('wait', 'Откройте в этой вкладке форму брони на gorod.it-minsk.by');
    renderPlan(null);
    renderOutcome(null);
    renderTrouble(null);
    renderAccount(null);
    return;
  }

  // Порядок важен: сначала то, что человек может починить прямо сейчас.
  const r = state.readiness;
  if (!r.ok) setStatus('bad', r.text);
  else {
    // Страница и кабинет в порядке — всё решает проверка на робота.
    const a = state.guard.advice;
    setStatus(a.level === 'ok' ? 'ok' : a.level === 'bad' ? 'bad' : 'wait', a.text);
  }

  renderPlan(state.plan);
  renderOutcome(state);
  renderTrouble(state);
  renderAccount(state);
}

async function refresh() {
  if (tabId == null) return;
  const res = await askState(tabId);
  if (res && res.ok) render(res.state);
  else if (res && !res.ok) {
    render(null);
    setStatus('bad', 'Не смог прочитать страницу — обновите её (F5)');
  } else render(null);
}

// Замер часов один раз за открытие панели: чаще незачем.
async function measureClock() {
  clockSync = await syncClock();
  clockOffset = usableOffset(clockSync);
  renderClock();
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'SET_CLOCK', sync: clockSync }, () => void chrome.runtime.lastError);
  }
}

async function main() {
  $('copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(troubleReport(lastState));
      $('copy-done').textContent = 'Скопировано — вставьте в сообщение.';
    } catch (e) {
      $('copy-done').textContent = 'Не получилось скопировать — просто пришлите фото окна.';
    }
  });

  tick();
  setInterval(tick, 250);
  renderClock();

  const tab = await activeTab();
  tabId = tab && tab.id != null ? tab.id : null;
  await refresh();
  await measureClock();
  // Раз в секунду перечитываем страницу: человек проходит проверку при открытой панели
  // и должен увидеть это сразу, не закрывая и не открывая её заново.
  setInterval(refresh, 1000);
}

main();
