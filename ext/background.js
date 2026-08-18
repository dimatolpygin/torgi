// Фоновый скрипт (service worker). Появился на этапе ext-6 ровно ради одного дела:
// отправить итог ночи НАШЕМУ серверу. Почему не со страницы сайта:
//   — у страницы своя политика безопасности (CSP), сторонний адрес она бы срезала;
//   — панель к полуночи может быть закрыта, а фоновый скрипт Chrome разбудит сам.
// К сайту брони отсюда не уходит ни одного запроса — только на адрес, который человек
// сам вписал в панели.

importScripts('config.js', 'lib/report.js', 'lib/send.js');

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

// Право на подачу (этап ext-5). Если человек открыл форму в двух вкладках, каждая
// подала бы свои 2 заявки — лимит кабинета 2 места в сутки, лишние получили бы отказ,
// а частая долбёжка ещё и упирается в ограничение сайта (429 ловили живьём 07.08).
// Право выдаётся первой попросившей вкладке на конкретную полночь; ей же оно
// подтверждается при повторном запросе.
var shotClaims = new Map(); // '<момент полуночи>' → id вкладки

// Значок на кнопке расширения. Панель всплывающая — к полуночи она закрыта, и если сайт
// потребует проверку прямо на отправке, докричаться до человека больше нечем. Красный «!»
// на значке видно в любой вкладке. Права на уведомления для этого не нужны: значок есть
// у любого расширения с кнопкой, и просить за него ничего не надо.
var BADGES = {
  alert: { text: '!', color: '#c62828' },
  ok: { text: '✓', color: '#2e7d32' },
  clear: { text: '', color: '#000000' },
};

function setBadge(kind) {
  const b = BADGES[kind] || BADGES.clear;
  try {
    chrome.action.setBadgeText({ text: b.text });
    chrome.action.setBadgeBackgroundColor({ color: b.color });
  } catch (e) {
    /* значок — вежливость, а не механика ночи: его отсутствие ничего не ломает */
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SET_BADGE') {
    setBadge(msg.kind);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'CLAIM_SHOT') {
    const tabId = _sender && _sender.tab && _sender.tab.id != null ? _sender.tab.id : -1;
    const d = decideClaim(shotClaims, msg.targetMs, tabId);
    sendResponse({ ok: true, granted: d.granted, holder: d.holder });
    return false;
  }
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
