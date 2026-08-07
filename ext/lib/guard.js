// Проверка на робота: наблюдение за токеном, который выдаёт ВИДЖЕТ после того, как
// проверку прошёл ЧЕЛОВЕК. Расширение токен только читает из уже открытой страницы —
// не запрашивает, не подделывает, не обходит проверку (жёсткое правило Вехи 3).
//
// Чистые функции: на вход обычные данные, никакого DOM — прогоняются из node.

// Имена скрытых полей, в которые провайдеры кладут токен.
var TOKEN_FIELD_NAMES = ['cf-turnstile-response', 'g-recaptcha-response', 'h-captcha-response'];

// Срок жизни токена Turnstile — 5 минут (300 с) с момента выдачи. Отсюда и требование
// к клиентке быть у компьютера к полуночи.
var TOKEN_TTL_MS = 5 * 60 * 1000;
// За сколько до истечения панель начинает предупреждать заранее.
var TOKEN_WARN_MS = 60 * 1000;
// Сколько ждать токен после загрузки страницы, прежде чем сказать «похоже, нужен клик».
var CLICK_HINT_AFTER_MS = 10 * 1000;

// Чем закрыта форма — по тому, что видно на странице.
function guardKindFromSources(sources) {
  const s = sources || {};
  const all = [...(s.scripts || []), ...(s.iframes || [])].join(' ');
  const classes = (s.classes || []).join(' ');
  const inputs = (s.inputNames || []).join(' ');
  if (/challenges\.cloudflare\.com/i.test(all) || /\bcf-turnstile\b/.test(classes) || /cf-turnstile-response/.test(inputs)) return 'turnstile';
  if (/(google\.com|recaptcha\.net)\/recaptcha/i.test(all) || /\bg-recaptcha\b/.test(classes) || /g-recaptcha-response/.test(inputs)) return 'recaptcha';
  if (/hcaptcha\.com/i.test(all) || /\bh-captcha\b/.test(classes) || /h-captcha-response/.test(inputs)) return 'hcaptcha';
  return null;
}

// Состояние токена: жив ли, сколько осталось, доживёт ли до полуночи.
// seenAt — момент, когда расширение УВИДЕЛО непустой токен. issuedKnown=false означает,
// что токен уже лежал в форме, когда панель начала смотреть: тогда он мог быть выдан
// раньше, и реальный срок годности меньше показанного — об этом честно пишем.
function tokenStatus(input) {
  const o = input || {};
  const now = o.now == null ? Date.now() : o.now;
  const ttl = o.ttlMs == null ? TOKEN_TTL_MS : o.ttlMs;
  const warn = o.warnMs == null ? TOKEN_WARN_MS : o.warnMs;
  const token = o.token || '';

  if (!token) {
    return {
      state: 'none',
      leftMs: 0,
      expiresAt: null,
      coversTarget: false,
      issuedKnown: false,
      text: 'Проверка не пройдена — токена нет',
    };
  }

  const expiresAt = o.seenAt + ttl;
  const leftMs = expiresAt - now;
  // Доживёт ли токен до момента подачи. Именно это, а не «жив сейчас», решает исход ночи.
  const coversTarget = o.targetMs == null ? leftMs > 0 : expiresAt >= o.targetMs;
  const state = leftMs <= 0 ? 'expired' : leftMs <= warn ? 'soon' : 'valid';
  return {
    state,
    leftMs: Math.max(0, leftMs),
    expiresAt,
    coversTarget,
    issuedKnown: o.issuedKnown !== false,
    text: state === 'expired' ? 'Токен истёк — пройдите проверку заново' : 'Проверка пройдена, токен получен',
  };
}

// Когда человеку проходить проверку, чтобы токен дожил до подачи. Раньше — протухнет,
// позже — можно не успеть. Возвращает окно [не раньше; крайний срок] в epoch ms.
function refreshWindow(targetMs, ttlMs, safetyMs) {
  const ttl = ttlMs == null ? TOKEN_TTL_MS : ttlMs;
  const safety = safetyMs == null ? 30 * 1000 : safetyMs; // запас на неспешные действия
  return { notBefore: targetMs - ttl + safety, deadline: targetMs - safety };
}

// Единая формулировка для панели: что человеку сделать прямо сейчас.
// Порядок веток — по срочности: сначала то, что рушит ночь, потом мелочи.
function guardAdvice(input) {
  const o = input || {};
  const now = o.now == null ? Date.now() : o.now;
  const st = o.status || { state: 'none' };
  const win = refreshWindow(o.targetMs, o.ttlMs);

  if (!o.kind) return { level: 'wait', text: 'Проверки на робота на странице не видно — возможно, её сняли' };

  if (st.state === 'none') {
    if (o.widgetSeen && o.pageAgeMs != null && o.pageAgeMs > CLICK_HINT_AFTER_MS) {
      return { level: 'bad', text: 'Пройдите проверку в форме — похоже, нужно нажать галочку «Я не робот»' };
    }
    // Уже вошли в окно, когда токен доживёт до подачи, а его нет — главная беда ночи.
    if (now >= win.notBefore) return { level: 'bad', text: 'Проверка не пройдена — пройдите её прямо сейчас' };
    return { level: 'wait', text: 'Проверка пока не пройдена — это нормально, пройдите ближе к полуночи' };
  }

  if (st.state === 'expired') return { level: 'bad', text: 'Токен истёк — пройдите проверку заново' };
  if (!st.coversTarget) return { level: 'bad', text: 'Токен истечёт до полуночи — пройдите проверку заново ближе к 00:00' };
  if (st.state === 'soon') return { level: 'wait', text: 'Токен скоро истечёт — обновите проверку' };
  if (!st.issuedKnown) return { level: 'ok', text: 'Токен есть (выдан до открытия панели — на всякий случай обновите проверку перед полуночью)' };
  return { level: 'ok', text: 'Проверка пройдена, токен годен до подачи' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TOKEN_FIELD_NAMES,
    TOKEN_TTL_MS,
    TOKEN_WARN_MS,
    CLICK_HINT_AFTER_MS,
    guardKindFromSources,
    tokenStatus,
    refreshWindow,
    guardAdvice,
  };
}
