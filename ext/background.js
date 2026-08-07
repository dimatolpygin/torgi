// Фоновый скрипт (service worker). Появился на этапе ext-6 ровно ради одного дела:
// отправить итог ночи НАШЕМУ серверу. Почему не со страницы сайта:
//   — у страницы своя политика безопасности (CSP), сторонний адрес она бы срезала;
//   — панель к полуночи может быть закрыта, а фоновый скрипт Chrome разбудит сам.
// К сайту брони отсюда не уходит ни одного запроса — только на адрес, который человек
// сам вписал в панели.

importScripts('lib/report.js');

var SETTINGS_KEYS = ['reportUrl', 'reportSecret'];
// Последняя доставка — панель показывает её человеку, чтобы «ушло / не ушло» было видно,
// а не угадывалось.
var lastDelivery = null;

function readSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(SETTINGS_KEYS, (v) => {
        void chrome.runtime.lastError;
        resolve({ url: (v && v.reportUrl) || '', secret: (v && v.reportSecret) || '' });
      });
    } catch (e) {
      resolve({ url: '', secret: '' });
    }
  });
}

async function deliver(body) {
  const s = await readSettings();
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
