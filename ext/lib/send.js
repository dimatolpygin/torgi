// Боевая отправка заявки (этап ext-5). Единственное место во всём расширении, откуда
// уходит запрос к сайту брони, — и уходит он ровно один раз за ночь на каждое место.
//
// Три правила, каждое оплачено живыми ночами бота:
//   1) ОДИН выстрел. Ночь 07.08 показала `HTTP 429 Too Many Requests` на повторных
//      попытках — повторы не помогают, а мешают. Никакого цикла долбёжки здесь нет.
//   2) Тело готовится ЗАРАНЕЕ, в 00:00:00.000 остаётся только приклеить свежий токен и
//      вызвать fetch. Сборка payload в момент выстрела стоила бы миллисекунд на ровном месте.
//   3) Запрос идёт на СВОЙ ЖЕ origin относительным путём, с кукой страницы
//      (`credentials: 'same-origin'`). Это тот же запрос, который сделал бы сам сайт по
//      нажатию кнопки, — ни чужих доменов, ни подмены заголовков.
//
// Сам fetch вкладывается снаружи (deps.fetch) — так отправку можно прогнать из node
// на подставном сервере и увидеть, что именно ушло, не трогая настоящий сайт.

// Сколько ждём ответа. Сервер в полночь думает 3–7 секунд (замеры бота, `maxResponseMs`),
// 15 с — с запасом; дольше ждать бессмысленно, дату к тому времени уже разобрали.
var SUBMIT_TIMEOUT_MS = 15000;

// Тело POST без токена. Готовится при заводе таймера — за минуты до выстрела.
function prepareBody(payload) {
  return encodeForm(payload);
}

// Приклеить токен к готовому телу. Отдельно от prepareBody намеренно: виджет обновляет
// токен сам, и в момент выстрела нужен ПОСЛЕДНИЙ, а не тот, что был при заводе.
function bodyWithToken(bodyPrefix, tokenField, token) {
  if (!tokenField || !token) return String(bodyPrefix || '');
  return `${bodyPrefix}&${encodeURIComponent(tokenField)}=${encodeURIComponent(token)}`;
}

// Одна заявка. Возвращает то, что понимает lib/outcome.js: { status, text } либо
// { skipped } — «не отправляли и вот почему». Не бросает: упавший запрос одного места
// не должен унести с собой второе.
function submitOnce(input) {
  const o = input || {};
  const deps = o.deps || {};
  const doFetch = deps.fetch || ((...a) => fetch(...a));
  const now = deps.now || (() => Date.now());
  const startedAt = now();

  // Таймаут через AbortController, если он есть; в node-проверке его подменяют.
  let signal;
  let timer = null;
  const AC = deps.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
  const ctrl = AC ? new AC() : null;
  if (ctrl) {
    signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), o.timeoutMs || SUBMIT_TIMEOUT_MS);
  }

  // Заголовки, по которым видно защиту, а не сайт: `cf-mitigated` Cloudflare ставит
  // сам, когда придержал запрос. Бот собирает ровно этот же набор с 04.08 (коммит
  // 9cb4426) — тогда в логе был один `code=500` и восстанавливать причину было нечем.
  const pickHeader = (h, n) => {
    try {
      return h && h.get ? h.get(n) || '' : '';
    } catch (e) {
      return '';
    }
  };
  const defenceHeaders = (h) => ({ 'cf-mitigated': pickHeader(h, 'cf-mitigated'), 'cf-ray': pickHeader(h, 'cf-ray'), server: pickHeader(h, 'server') });

  return doFetch(o.url, {
    method: 'POST',
    // Кука кабинета обязана уехать вместе с запросом — иначе сервер не узнает человека.
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      // Сайт отвечает JSON именно на AJAX-запрос — ровно тот же заголовок шлёт бот.
      'x-requested-with': 'XMLHttpRequest',
    },
    body: o.body,
    signal,
  })
    .then((res) => res.text().then((text) => ({ status: res.status, text, headers: defenceHeaders(res.headers), tookMs: now() - startedAt })))
    .catch((e) => ({
      // Ответа не будет — но это не «отказ сайта», а обрыв, и назвать это надо честно.
      status: null,
      text: '',
      error: String(e && e.name === 'AbortError' ? 'сервер не ответил вовремя' : e && e.message ? e.message : e),
      tookMs: now() - startedAt,
    }))
    .then((r) => {
      if (timer) clearTimeout(timer);
      // Обрыв соединения — не молчание сервера, а сетевая беда: помечаем отдельным
      // полем, чтобы разбор итога не выдал её за отказ сайта.
      if (r.error && r.status == null) return { networkError: r.error, tookMs: r.tookMs };
      return r;
    });
}

// Кто из открытых вкладок стреляет. Решение вынесено сюда отдельной чистой функцией
// (пользуется им фоновый скрипт), чтобы его можно было прогнать из node: «две вкладки на
// одну полночь — стреляет одна», а не проверять это живой ночью.
function decideClaim(claims, targetMs, tabId) {
  const key = String(targetMs);
  const holder = claims.get(key);
  const granted = holder == null || holder === tabId;
  if (granted) claims.set(key, tabId);
  return { granted, holder: holder == null ? null : holder };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUBMIT_TIMEOUT_MS, prepareBody, bodyWithToken, submitOnce, decideClaim };
}
