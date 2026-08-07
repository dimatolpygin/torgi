// Панель. Спрашивает content script активной вкладки и рисует, что тот увидел.
// Обратный отсчёт идёт по часам ПК — на этапе ext-1 этого достаточно; сверка часов
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

function tick() {
  const left = target.ms - Date.now();
  if (left <= 0) {
    // Полночь прошла, пока панель открыта — пересчитываем цель на следующую ночь.
    target = nextRegistrationMidnight();
  }
  $('countdown').textContent = formatCountdown(target.ms - Date.now());
  $('target').textContent = `подача в 00:00, ночь на ${formatDateRu(target)}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function askState(tabId) {
  // Постороння страница = content script не внедрён, ответа не будет. Ошибку
  // chrome.runtime.lastError гасим намеренно: это не сбой, а «не та вкладка».
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' }, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

function render(state) {
  const booking = state ? state.booking : bookingDateFor(target);
  $('booking').textContent = `${formatDateRu(booking)} (${booking.dateStr})`;

  if (!state) {
    $('account').textContent = 'страница не открыта';
    setStatus('wait', 'Откройте в этой вкладке форму брони на gorod.it-minsk.by');
    return;
  }
  const acc = state.account;
  $('account').textContent = acc.loggedIn ? shortFio(acc) : 'не вижу';
  const r = state.readiness;
  setStatus(r.ok ? 'ok' : 'bad', r.ok ? `Страница подачи распознана. Кабинет: ${acc.fio}` : r.text);
}

async function main() {
  tick();
  setInterval(tick, 250);

  const tab = await activeTab();
  const res = tab && tab.id != null ? await askState(tab.id) : null;
  if (res && res.ok) render(res.state);
  else if (res && !res.ok) {
    render(null);
    setStatus('bad', `Не смог прочитать страницу: ${res.error}`);
  } else render(null);
}

main();
