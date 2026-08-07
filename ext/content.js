// Content script: живёт на странице подачи и по запросу панели рассказывает, что видит.
// Этап ext-1 — только чтение: ни одного запроса к сайту, ни одного изменения страницы.
// Правило вехи: расширение делает ровно то, что сделал бы человек, — не больше.

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

function collectFormActions() {
  return Array.from(document.querySelectorAll('form')).map((f) => f.getAttribute('action') || '');
}

function readState() {
  const fields = collectFields();
  const account = accountFromFields(fields);
  const onSubmitPage = isSubmitPage(location.href, collectFormActions());
  const target = nextRegistrationMidnight();
  const booking = bookingDateFor(target);
  const state = { onSubmitPage, account, target, booking, url: location.href, readAt: Date.now() };
  state.readiness = readiness(state);
  return state;
}

// Панель спрашивает — content script отвечает. Если content script на странице не
// запущен (значит, страница посторонняя), sendMessage просто не получит ответа —
// панель это и покажет. Никакого фонового скрипта для этого не нужно.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'GET_STATE') {
    try {
      sendResponse({ ok: true, state: readState() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return false; // ответ синхронный
});
