// Доставка итога ночи на наш сервер (оттуда бот шлёт его в Telegram существующими
// средствами). Токена бота в расширении нет и не будет: расширение живёт на чужом ПК,
// а телеграм-токен даёт полный доступ к боту. Наружу уходит только подписанный отчёт.
//
// Подпись: HMAC-SHA256 по строке «<время>.<тело>» общим секретом. Секрет вводит человек
// один раз в панели, лежит он в chrome.storage.local — в репозитории его нет (это
// критерий этапа, он же проверяется машинно в check-ext.js).
//
// Железное правило этапа: отчёт вторичен. Ни одна ошибка отсюда не должна долетать до
// подачи — все функции ниже не бросают, а возвращают { ok:false, error }.

var REPORT_TIMEOUT_MS = 8000;
var REPORT_SIG_HEADER = 'x-bron-signature';
var REPORT_TS_HEADER = 'x-bron-ts';

function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// Подписываемая строка. Время входит в подпись, иначе перехваченный отчёт можно было бы
// переслать сервером повторно (сервер отбрасывает отчёты старше своего окна).
function signedString(ts, bodyJson) {
  return `${ts}.${bodyJson}`;
}

async function signBody(ts, bodyJson, secret, subtleImpl) {
  const subtle = subtleImpl || (typeof crypto !== 'undefined' ? crypto.subtle : null);
  if (!subtle) throw new Error('нет crypto.subtle');
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, enc.encode(signedString(ts, bodyJson)));
  return toHex(sig);
}

// Что не так с настройками. Проверяется до полуночи, чтобы человек успел поправить,
// а не узнал об этом в 00:00:01.
function reportSettingsProblems(settings) {
  const s = settings || {};
  const problems = [];
  if (!s.url) problems.push('не задан адрес сервера для отчёта');
  else if (!/^https?:\/\/.+/i.test(s.url)) problems.push('адрес сервера должен начинаться с http:// или https://');
  if (!s.secret) problems.push('не задано общее слово (секрет) для отчёта');
  else if (String(s.secret).length < 16) problems.push('общее слово короче 16 символов — так его подберут');
  return problems;
}

// Отправка. Все ошибки — в возврат, наружу не летят.
async function sendReport(input) {
  const o = input || {};
  const problems = reportSettingsProblems({ url: o.url, secret: o.secret });
  if (problems.length) return { ok: false, error: problems.join('; ') };

  const doFetch = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'в этом окружении нет fetch' };

  try {
    const bodyJson = JSON.stringify(o.body || {});
    const ts = String(o.now == null ? Date.now() : o.now);
    const sig = await signBody(ts, bodyJson, o.secret, o.subtle);

    // Сетевой таймаут обязателен: без него отчёт на мёртвом сервере висел бы до
    // закрытия вкладки и держал бы страницу подачи занятой.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs || REPORT_TIMEOUT_MS) : null;

    let res;
    try {
      res = await doFetch(o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [REPORT_SIG_HEADER]: sig, [REPORT_TS_HEADER]: ts },
        body: bodyJson,
        signal: ctrl ? ctrl.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = res && res.status != null ? res.status : 0;
    if (status >= 200 && status < 300) return { ok: true, status };
    return { ok: false, status, error: `сервер ответил ${status}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REPORT_TIMEOUT_MS, REPORT_SIG_HEADER, REPORT_TS_HEADER, signedString, signBody, sendReport, reportSettingsProblems, toHex };
}
