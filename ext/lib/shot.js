// Выстрел: ожидание точного момента и залп. Повторяет то, что делает бот
// (src/scheduler.js, src/runner.js), но в браузере и с двумя оговорками:
//   1) часы браузера сдвинуты — момент считаем с поправкой (см. lib/clock.js);
//   2) отправка вкладывается ИЗВНЕ. Сам этот файл ничего не отправляет: на этапе ext-4
//      ему подсовывают заглушку-тренировку, боевая отправка появится в ext-5.
//
// Зависимости (часы, таймер) тоже передаются снаружи — так весь планировщик целиком
// прогоняется из node и его точность можно ИЗМЕРИТЬ, а не пообещать.

// За сколько до цели уходим с таймера на активное ожидание. Таймеры браузера просыпаются
// с точностью ±15 мс и охотно опаздывают — последний отрезок вычитываем циклом.
var BUSY_WAIT_MS = 200;
// Активное ожидание длиной в BUSY_WAIT_MS держит поток занятым. Это осознанно: столько же
// делает бот, а 200 мс подвисания страницы в полночь никому не мешают.

function waitUntil(localTargetMs, deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const later = d.setTimeout || ((fn, ms) => setTimeout(fn, ms));

  return new Promise((resolve) => {
    const step = () => {
      const left = localTargetMs - now();
      if (left > BUSY_WAIT_MS) {
        later(step, left - BUSY_WAIT_MS);
        return;
      }
      // Последние миллисекунды — вручную. Выходим ровно тогда, когда часы дошли до цели.
      let t = now();
      while (t < localTargetMs) t = now();
      resolve(t);
    };
    step();
  });
}

// Залп. Все отправки стартуют в ОДНОМ синхронном такте — это и есть «параллельно»:
// ни одна не ждёт ответа предыдущей. Ровно на этом сгорел бот в этапе 23, когда обе
// заявки шли последовательными await по одному сокету и вторая опаздывала на 8 секунд.
function volley(count, sendOne, deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const starts = [];
  const jobs = [];

  for (let i = 0; i < count; i += 1) {
    starts.push(now());
    // Отправку вызываем синхронно, а в промис заворачиваем уже результат: если обернуть
    // сам вызов в Promise.resolve().then(...), старт уедет в следующий такт и залп
    // перестанет быть залпом.
    try {
      jobs.push(Promise.resolve(sendOne(i)).then((r) => ({ ok: true, i, result: r }), (e) => ({ ok: false, i, error: String(e && e.message ? e.message : e) })));
    } catch (e) {
      jobs.push(Promise.resolve({ ok: false, i, error: String(e && e.message ? e.message : e) }));
    }
  }

  return Promise.all(jobs).then((results) => ({ starts, results }));
}

// Полный выстрел: дождаться момента и дать залп.
function shootAt(input) {
  const o = input || {};
  const deps = o.deps || {};
  const now = deps.now || (() => Date.now());
  const local = o.localTargetMs;

  return waitUntil(local, deps).then((wokeAt) =>
    volley(o.count || 1, o.sendOne, deps).then((v) =>
      volleyReport({
        localTargetMs: local,
        offsetMs: o.offsetMs || 0,
        wokeAt,
        starts: v.starts,
        results: v.results,
        finishedAt: now(),
      }),
    ),
  );
}

// Разбор того, что получилось. Две разные величины, их нельзя путать:
//   driftMs  — насколько первая отправка разошлась с целью (точность выстрела);
//   spreadMs — насколько разъехались отправки между собой (параллельность залпа).
function volleyReport(input) {
  const o = input || {};
  const starts = o.starts || [];
  const first = starts.length ? Math.min(...starts) : null;
  const last = starts.length ? Math.max(...starts) : null;

  const driftMs = first == null ? null : first - o.localTargetMs;
  const spreadMs = first == null ? null : last - first;
  // parallel: залп признаём одномоментным, если отправки разъехались меньше чем на
  // разрешение самих часов браузера (performance-таймер в Chrome огрублён до ~0,1 мс,
  // Date — до 1 мс), плюс запас на цикл.
  const parallel = spreadMs != null && spreadMs <= 2;

  return {
    at: first,
    // Момент в НАСТОЯЩЕМ времени — по нему сверяться с полуночью, а не по часам ПК.
    atTrueMs: first == null ? null : first + (o.offsetMs || 0),
    driftMs,
    spreadMs,
    parallel,
    count: starts.length,
    results: o.results || [],
    wokeAt: o.wokeAt == null ? null : o.wokeAt,
    tookMs: o.finishedAt == null || first == null ? null : o.finishedAt - first,
    text: describeShot({ driftMs, spreadMs, parallel, count: starts.length }),
  };
}

function formatDrift(ms) {
  if (ms == null) return '—';
  const v = Math.round(ms);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} мс`;
}

function describeShot(r) {
  if (!r || !r.count) return 'Залпа не было';
  const acc = formatDrift(r.driftMs);
  const par = r.parallel ? 'одновременно' : `вразнобой на ${Math.round(r.spreadMs)} мс`;
  return `${r.count} шт., отклонение от цели ${acc}, отправлены ${par}`;
}

// Следующая ровная минута — ложная цель для тренировочного залпа. Ждать полуночи, чтобы
// убедиться, что планировщик работает, незачем.
function nextRoundMinute(now) {
  const t = now == null ? Date.now() : now;
  return Math.ceil((t + 1000) / 60000) * 60000;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { waitUntil, volley, shootAt, volleyReport, describeShot, formatDrift, nextRoundMinute, BUSY_WAIT_MS };
}
