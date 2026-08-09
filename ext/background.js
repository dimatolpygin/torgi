// Фоновый скрипт (service worker). Появился на этапе ext-6 ровно ради одного дела:
// отправить итог ночи НАШЕМУ серверу. Почему не со страницы сайта:
//   — у страницы своя политика безопасности (CSP), сторонний адрес она бы срезала;
//   — панель к полуночи может быть закрыта, а фоновый скрипт Chrome разбудит сам.
// К сайту брони отсюда не уходит ни одного запроса — только на адрес, который человек
// сам вписал в панели.

importScripts('config.js', 'lib/report.js');

// Настройки доставки задаёт разработчик в config.js, а не человек в панели: клиентке
// незачем видеть адреса и общие слова. Пока адрес пуст, отсюда не уходит ничего.
var lastDelivery = null;

function readSettings() {
  return Promise.resolve({ url: REPORT_URL, secret: REPORT_SECRET });
}

async function deliver(body) {
  const s = await readSettings();
  if (!reportConfigured()) {
    lastDelivery = { at: Date.now(), ok: false, error: 'доставка итога не настроена', status: null };
    return { ok: false, error: 'доставка итога не настроена' };
  }
  const res = await sendReport({ url: s.url, secret: s.secret, body });
  lastDelivery = { at: Date.now(), ok: res.ok, error: res.error || null, status: res.status == null ? null : res.status };
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SEND_REPORT') {
    // Ошибку доставки гасим здесь же: подача уже состоялась, и отчёт не имеет права
    // испортить её итог. Наверх уходит только «получилось/не получилось».
    deliver(msg.body).then(
      (res) => sendResponse(res),
      (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }),
    );
    return true; // ответ асинхронный
  }
  if (msg && msg.type === 'REPORT_STATE') {
    readSettings().then((s) => {
      sendResponse({
        ok: true,
        configured: reportSettingsProblems(s).length === 0,
        problems: reportSettingsProblems(s),
        url: s.url,
        lastDelivery,
      });
    });
    return true;
  }
  return false;
});
