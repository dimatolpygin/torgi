// Часы. Браузер клиентки стреляет по СВОИМ часам, а полночь наступает по настоящим —
// значит, разницу надо измерить и учесть. Здесь только арифметика: сами замеры делает
// clocksync.js (единственный файл расширения, который ходит в сеть), и ходит он НЕ на
// сайт брони — эталон времени не должен создавать сайту ни одного запроса.
//
// Чистые функции: на вход обычные числа, никакого DOM и никакой сети — прогоняются из node.

// Сколько замеров делать и с каким интервалом. Замеры крошечные (пара сотен байт),
// но и их незачем плодить: медиана по 5 пробам уже устойчива к случайному тормозу сети.
var CLOCK_PROBES = 5;
var CLOCK_PROBE_GAP_MS = 200;
// Расхождение крупнее секунды — человеку об этом надо сказать: значит, часы ПК реально
// сбиты, и если поправка вдруг не применится, ночь будет потеряна.
var CLOCK_WARN_MS = 1000;
// Мельче этого поправку считаем шумом сети и не двигаем выстрел: сдвигать на 5 мс
// туда-сюда по случайному джиттеру вреднее, чем не сдвигать вовсе.
var CLOCK_TRUST_MS = 20;
// Замер с таким разбросом ответов доверия не заслуживает — сеть в этот момент дышала.
var CLOCK_SPREAD_LIMIT_MS = 400;

// Одна проба по формуле NTP: t0 — момент отправки по нашим часам, serverMs — время,
// которое назвал эталон, t1 — момент получения ответа. Считаем, что дорога туда и
// обратно заняла поровну; ошибка этого допущения не больше половины RTT.
function probeOffset(p) {
  const t0 = Number(p.t0);
  const t1 = Number(p.t1);
  return {
    offsetMs: Number(p.serverMs) - (t0 + t1) / 2,
    rttMs: t1 - t0,
  };
}

function median(values) {
  const xs = values.slice().sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Свод замеров в одну поправку. Берём половину проб с наименьшим RTT: чем короче дорога,
// тем меньше неопределённость «поровну туда-обратно». По ним — медиану, она не боится
// одного выброса, в отличие от среднего.
function mergeProbes(probes) {
  const list = (probes || []).filter((p) => p && Number.isFinite(p.offsetMs) && Number.isFinite(p.rttMs));
  if (!list.length) return { ok: false, offsetMs: 0, rttMs: null, spreadMs: null, samples: 0, used: 0 };

  const byRtt = list.slice().sort((a, b) => a.rttMs - b.rttMs);
  const used = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2)));
  const offsets = used.map((p) => p.offsetMs);

  return {
    ok: true,
    offsetMs: median(offsets),
    rttMs: used[0].rttMs,
    spreadMs: Math.max(...offsets) - Math.min(...offsets),
    samples: list.length,
    used: used.length,
  };
}

// Стоит ли применять измеренную поправку к выстрелу.
function usableOffset(sync) {
  const s = sync || {};
  if (!s.ok) return 0;
  if (s.spreadMs != null && s.spreadMs > CLOCK_SPREAD_LIMIT_MS) return 0;
  if (Math.abs(s.offsetMs) < CLOCK_TRUST_MS) return 0;
  return s.offsetMs;
}

// Что показать человеку про часы его ПК.
function clockVerdict(sync) {
  const s = sync || {};
  if (!s.ok) {
    return { level: 'warn', text: 'Поправка не измерена — стреляем по часам компьютера' };
  }
  const off = Math.round(s.offsetMs);
  const where = off > 0 ? 'отстают' : 'спешат';
  const secs = (Math.abs(off) / 1000).toFixed(1);

  if (s.spreadMs > CLOCK_SPREAD_LIMIT_MS) {
    return { level: 'warn', text: `Сеть дышит (разброс ${Math.round(s.spreadMs)} мс) — поправку не применяю` };
  }
  if (Math.abs(off) > CLOCK_WARN_MS) {
    return { level: 'warn', text: `Часы компьютера ${where} на ${secs} с — поправка учтена, но лучше синхронизировать часы Windows` };
  }
  if (Math.abs(off) < CLOCK_TRUST_MS) {
    return { level: 'ok', text: `Часы точны (расхождение ${Math.abs(off)} мс)` };
  }
  return { level: 'ok', text: `Часы ${where} на ${Math.abs(off)} мс — поправка учтена` };
}

// Настоящее время по нашим часам с поправкой.
function correctedNow(now, offsetMs) {
  return now + (offsetMs || 0);
}

// Обратный перевод: в какой момент ПО ЧАСАМ КОМПЬЮТЕРА наступит настоящая полночь.
// Именно это число уходит в планировщик — таймеры браузера живут в местных часах.
function localTargetMs(targetMs, offsetMs) {
  return targetMs - (offsetMs || 0);
}

function formatOffset(offsetMs) {
  if (offsetMs == null) return '—';
  const ms = Math.round(offsetMs);
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  const abs = Math.abs(ms);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(2)} с` : `${sign}${abs} мс`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    probeOffset,
    median,
    mergeProbes,
    usableOffset,
    clockVerdict,
    correctedNow,
    localTargetMs,
    formatOffset,
    CLOCK_PROBES,
    CLOCK_PROBE_GAP_MS,
    CLOCK_WARN_MS,
    CLOCK_TRUST_MS,
    CLOCK_SPREAD_LIMIT_MS,
  };
}
