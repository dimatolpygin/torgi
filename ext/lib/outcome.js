// Итог ночи: разбор ответов сервера на create_zajav и человеческая фраза по ним.
// Повторяет то, что бот пишет в лог и в Telegram (src/site/order.js — разбор ответа,
// src/messages.js — outcomeText), чтобы клиентка не различала, кто подал: бот или
// расширение.
//
// Здесь нет ни отправки заявки, ни отправки отчёта — только чтение того, что уже
// вернулось, и слова для человека. Транспорт отчёта живёт в lib/report.js.

// Сервер сайта отвечает своим кодом ВНУТРИ тела (HTTP при этом бывает 200 даже на отказ —
// это видно по живым ночам 06–07.08.2026). Принято = code 200 или 201.
var ACCEPT_CODES = ['200', '201'];

// Причины отказа, которые сайт называет полями ответа. Ночи 06–07.08 показали, что
// чаще он не называет ничего — на этот случай есть отдельные ветки ниже.
var FIELD_REASONS = {
  no_date: 'этой даты уже не было (места разобрали)',
  empty: 'сайт счёл поле пустым',
  no_assort: 'не принят ассортимент',
  length: 'сайт счёл поле слишком коротким',
};

// Разбор ОДНОГО ответа. На вход — то, что вернула отправка:
//   { status, text }  — HTTP-статус и тело (боевая отправка, ext-5);
//   { dryRun: true }  — тренировка (сейчас);
// либо запись залпа { ok:false, error } — отправка вообще не состоялась.
function readAnswer(item) {
  const it = item || {};
  if (it.ok === false) return { accepted: false, kind: 'network', reason: `не отправилось (${it.error || 'сеть'})` };

  const r = it.ok === true ? it.result : it;
  if (!r) return { accepted: false, kind: 'network', reason: 'ответа не было' };
  if (r.dryRun) return { accepted: false, kind: 'drill', reason: 'тренировка — ничего не отправлялось' };

  const http = r.status == null ? null : Number(r.status);
  // 429 ловили живьём в ночь 07.08 на повторных попытках бота — расширение бьёт один раз,
  // но если сайт всё же ответит так, человек должен это увидеть словами, а не кодом.
  if (http === 429) return { accepted: false, kind: 'ratelimit', http, reason: 'сайт ограничил частоту запросов (429)' };

  let parsed = null;
  try {
    parsed = JSON.parse(String(r.text == null ? '' : r.text));
  } catch (e) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      accepted: false,
      kind: 'notjson',
      http,
      // Именно так выглядела ночь 04.08: вместо JSON пришла страница проверки на робота.
      reason: 'сервер вернул не ответ, а страницу (похоже на проверку на робота)',
      raw: String(r.text == null ? '' : r.text).slice(0, 200).replace(/\s+/g, ' '),
    };
  }

  const code = String(parsed.code == null ? '' : parsed.code);
  if (ACCEPT_CODES.indexOf(code) >= 0) return { accepted: true, kind: 'accepted', http, code };

  const fields = {};
  for (const k of Object.keys(parsed)) {
    if (k === 'code') continue;
    if (typeof parsed[k] === 'string' && parsed[k] !== '') fields[k] = parsed[k];
  }
  const named = Object.keys(fields).map((k) => FIELD_REASONS[fields[k]] || `${k}=${fields[k]}`);
  return {
    accepted: false,
    kind: 'rejected',
    http,
    code,
    fields,
    // Сайт умеет отказывать молча (code=500 без единого поля) — так и говорим,
    // вместо того чтобы выдумывать причину.
    reason: named.length ? named.join('; ') : `сайт отклонил заявку и причину не назвал (код ${code || '—'})`,
  };
}

// Итог по всему залпу.
function summarize(input) {
  const o = input || {};
  const items = o.results || [];
  const answers = items.map(readAnswer);
  const count = answers.length;
  const acceptedCount = answers.filter((a) => a.accepted).length;
  const drill = count > 0 && answers.every((a) => a.kind === 'drill');
  // Причины перечисляем без повторов: две одинаковые отбивки не должны выглядеть как две разные беды.
  const reasons = [];
  for (const a of answers) {
    if (a.accepted || !a.reason) continue;
    if (reasons.indexOf(a.reason) < 0) reasons.push(a.reason);
  }

  const out = {
    drill,
    count,
    acceptedCount,
    ok: !drill && count > 0 && acceptedCount === count,
    partial: !drill && acceptedCount > 0 && acceptedCount < count,
    reasons,
    answers,
    booking: o.booking || null,
    // Точность выстрела — из отчёта залпа (lib/shot.js). Нужна и в панели, и в Telegram.
    driftMs: o.shot && o.shot.driftMs != null ? o.shot.driftMs : null,
    spreadMs: o.shot && o.shot.spreadMs != null ? o.shot.spreadMs : null,
    atTrueMs: o.shot && o.shot.atTrueMs != null ? o.shot.atTrueMs : null,
  };
  out.text = describeOutcome(out);
  return out;
}

function placesWordExt(n) {
  const a = Math.abs(n) % 100;
  const b = n % 10;
  if (a > 10 && a < 20) return 'мест';
  if (b === 1) return 'место';
  if (b >= 2 && b <= 4) return 'места';
  return 'мест';
}

function describeOutcome(o) {
  if (!o || !o.count) return 'Залпа не было';
  const when = o.booking ? formatDateRu(o.booking) : 'нужную дату';
  if (o.drill) return `Тренировка: ${o.count} ${placesWordExt(o.count)} собрано, на сайт ничего не ушло`;
  if (o.ok) return `Принято ${o.acceptedCount} из ${o.count} — ${o.acceptedCount} ${placesWordExt(o.acceptedCount)} на ${when}`;
  if (o.partial) return `Принято ${o.acceptedCount} из ${o.count} на ${when}. Отказ по остальным: ${o.reasons.join('; ')}`;
  return `Не принято ни одной заявки на ${when}. Причина: ${o.reasons.join('; ') || 'сайт промолчал'}`;
}

// Тело отчёта нашему серверу. Правило: наружу уходит только то, что человек и так
// увидит в Telegram. Токен проверки, пароль и куки не уходят НИКОГДА — их здесь нет
// даже в виде поля, чтобы нечего было случайно подставить.
function reportBody(input) {
  const o = input || {};
  const out = o.outcome || {};
  return {
    v: 1,
    source: 'ext',
    at: o.now == null ? Date.now() : o.now,
    account: { fio: (o.account && o.account.fio) || '' },
    booking: o.booking ? { date: o.booking.dateStr, day: o.booking.day, month: o.booking.month, year: o.booking.year } : null,
    drill: !!out.drill,
    count: out.count || 0,
    acceptedCount: out.acceptedCount || 0,
    ok: !!out.ok,
    reasons: out.reasons || [],
    shot: { driftMs: out.driftMs, spreadMs: out.spreadMs, atTrueMs: out.atTrueMs },
    text: out.text || '',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ACCEPT_CODES, FIELD_REASONS, readAnswer, summarize, describeOutcome, reportBody, placesWordExt };
}
