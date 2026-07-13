// Замер смещения часов сервера сайта относительно НАШИХ часов (этап 19).
//
// Зачем: порядок в утреннем списке решает сервер сайта по факту записи заявки.
// Наши часы дисциплинированы ntp (на BY — stratum-1 эталон, offset <0.1 мс от
// истинного UTC), поэтому «смещение сайта vs наши часы» ≈ «смещение сайта vs
// истинный UTC». Если сайт спешит/отстаёт на десятки мс — это системная фора/потеря,
// которую можно учесть упреждением выстрела (этап 20).
//
// Как: заголовок `Date` имеет разрешение 1 с, поэтому одиночная проба даёт ±1 с.
// Точность повышаем детекцией «переворота» секунды: часто опрашиваем сайт по горячему
// keep-alive сокету и ловим момент, когда секунда в `Date` увеличивается на 1. Этот
// инкремент = ровно граница секунды по часам сайта. Локальное время в этот момент
// (среднее между соседними пробами, минус односторонняя задержка ≈ RTT/2) сравниваем
// с «круглой» секундой сайта. Несколько переворотов усредняем.

// Разобрать заголовок Date в epoch-мс (кратно 1000, т.к. разрешение 1 с). NaN — если нет/битый.
function parseDateHeader(headers) {
  const d = headers?.date;
  if (!d) return NaN;
  const ms = Date.parse(d);
  return Number.isFinite(ms) ? ms : NaN;
}

// Собрать пробы: back-to-back GET-запросы к лёгкой статике по горячему сокету.
// GET, а не HEAD: на этом Apache HEAD аномально медленный (~20–40 мс против ~3–6 мс
// на GET) — HEAD завышал бы RTT и портил поправку на one-way. Каждая проба:
// {t0, t1, dateMs, rtt}. Прогревочный первый запрос не считаем.
async function collectSamples(client, { path, durationMs, gapMs, maxFlips }) {
  const samples = [];
  try {
    await client.request('GET', path); // прогрев сокета/TLS — первый холодный не в счёт
  } catch {
    /* прогрев не критичен */
  }
  const deadline = Date.now() + durationMs;
  let flips = 0;
  let lastSec = null;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    let res;
    try {
      res = await client.request('GET', path);
    } catch {
      continue; // сетевой сбой пробы — пропускаем
    }
    const t1 = Date.now();
    const dateMs = parseDateHeader(res.headers);
    if (Number.isFinite(dateMs)) {
      samples.push({ t0, t1, dateMs, rtt: t1 - t0 });
      if (lastSec != null && dateMs === lastSec + 1000) flips++;
      lastSec = dateMs;
      if (maxFlips && flips >= maxFlips) break;
    }
    const wait = gapMs - (Date.now() - t1);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return samples;
}

// Медиана массива чисел.
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Смещение часов сайта относительно наших. Возвращает:
//   { offsetMs, offsetSpreadMs, rttMinMs, rttMedianMs, flips, samples }
// offsetMs > 0 → часы сайта СПЕШАТ относительно наших (сайт «думает», что позже).
// Односторонняя задержка оценивается как min(RTT)/2 (предполагаем симметрию канала).
export async function measureSiteClockOffset(
  client,
  { path = '/js/rinki/rinki.reg.js', durationMs = 3500, gapMs = 20, maxFlips = 4 } = {},
) {
  const samples = await collectSamples(client, { path, durationMs, gapMs, maxFlips });
  if (samples.length < 2) {
    return { offsetMs: null, offsetSpreadMs: null, rttMinMs: null, rttMedianMs: null, flips: 0, samples: samples.length };
  }

  const rtts = samples.map((s) => s.rtt);
  const rttMin = Math.min(...rtts);
  const oneWay = rttMin / 2; // симметричная оценка односторонней задержки

  // Смещения по каждому «чистому» перевороту секунды (+1000 мс между соседними пробами).
  const offsets = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (cur.dateMs !== prev.dateMs + 1000) continue; // интересует только чистый инкремент на 1 с
    // Граница секунды по часам сайта = cur.dateMs (круглая секунда). По нашим часам она
    // произошла между генерацией prev (Date=prev.dateMs) и cur. Момент получения ≈ t1;
    // сервер штампует Date при генерации, ответ идёт oneWay до нас → local ≈ t1 - oneWay.
    const boundaryLocal = (prev.t1 + cur.t1) / 2 - oneWay;
    offsets.push(cur.dateMs - boundaryLocal); // site - our
  }

  if (offsets.length === 0) {
    // Ни одного переворота не поймали (окно короткое/джиттер). Грубая оценка по последней
    // пробе: середина запроса против floor-секунды сайта, точность ±1 с — как ориентир.
    const last = samples[samples.length - 1];
    const mid = (last.t0 + last.t1) / 2;
    return {
      offsetMs: Math.round(last.dateMs + 500 - mid), // центр секунды сайта - наш центр запроса
      offsetSpreadMs: 1000,
      rttMinMs: rttMin,
      rttMedianMs: median(rtts),
      flips: 0,
      samples: samples.length,
      coarse: true,
    };
  }

  const offsetMs = Math.round(median(offsets));
  const spread = Math.round(Math.max(...offsets) - Math.min(...offsets));
  return {
    offsetMs,
    offsetSpreadMs: spread,
    rttMinMs: rttMin,
    rttMedianMs: median(rtts),
    flips: offsets.length,
    samples: samples.length,
  };
}

// Замер сетевого RTT по ГОРЯЧЕМУ keep-alive сокету (этап 20). Лёгкий путь (статика),
// чтобы измерять сеть + минимум обработки, а не тяжёлую генерацию страницы. Возвращает
// { rttMinMs, rttMedianMs, jitterMs, oneWayMs, samples }. oneWayMs = rttMin/2 — оценка
// односторонней задержки (потолок безопасного упреждения выстрела: больше → заявка
// прилетит до открытия даты в 00:00 и получит no_date).
export async function measureRtt(client, { path = '/js/rinki/rinki.reg.js', samples = 7 } = {}) {
  const rtts = [];
  try {
    await client.request('GET', path); // прогрев сокета — первый (холодный/TLS) не в счёт
  } catch {
    /* прогрев не критичен */
  }
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      await client.request('GET', path); // GET, не HEAD: HEAD на этом Apache ~20–40 мс
    } catch {
      continue;
    }
    rtts.push(Date.now() - t0);
  }
  if (rtts.length === 0) {
    return { rttMinMs: null, rttMedianMs: null, jitterMs: null, oneWayMs: null, samples: 0 };
  }
  const min = Math.min(...rtts);
  const max = Math.max(...rtts);
  const med = median(rtts);
  return {
    rttMinMs: min,
    rttMedianMs: med,
    jitterMs: max - min, // разброс round-trip (грубая мера джиттера)
    oneWayMs: min / 2,
    samples: rtts.length,
  };
}

// Строка RTT для лога/отчёта.
export function formatRtt(r) {
  if (!r || r.rttMinMs == null) return 'RTT: не измерен';
  return `RTT min ${r.rttMinMs} мс / медиана ${r.rttMedianMs} мс, джиттер ${r.jitterMs} мс (one-way ≈ ${r.oneWayMs.toFixed(1)} мс)`;
}

// Человекочитаемая строка для лога/отчёта.
export function formatClockOffset(c) {
  if (!c || c.offsetMs == null) return 'смещение сайта: не измерено';
  const sign = c.offsetMs >= 0 ? '+' : '';
  const dir = c.offsetMs >= 0 ? 'сайт спешит' : 'сайт отстаёт';
  const prec = c.coarse ? ' (грубо, ±1 с)' : ` (±${c.offsetSpreadMs} мс, ${c.flips} перевор.)`;
  const rtt = c.rttMinMs != null ? `, RTT min ${c.rttMinMs} мс / медиана ${c.rttMedianMs} мс` : '';
  return `${dir} ${sign}${c.offsetMs} мс${prec}${rtt}`;
}

export default measureSiteClockOffset;
