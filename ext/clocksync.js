// ЕДИНСТВЕННЫЙ файл расширения, который ходит в сеть. Живёт только в панели (popup.html),
// в content script не подключается — значит, на странице сайта у расширения по-прежнему
// нет ни одной возможности что-либо отправить.
//
// К сайту брони отсюда не уходит НИЧЕГО. Эталон времени — служебная страница Cloudflare
// `/cdn-cgi/trace`: она отдаёт своё время с точностью до миллисекунд, отвечает из
// ближайшей точки (короткая дорога = точная поправка) и это ровно та же сторона, которая
// и так обслуживает проверку на робота на странице клиентки — новых наблюдателей не
// появляется.
//
// Почему не наш боевой сервер (как задумывалось в плане): на нём нет и не было HTTP-службы,
// а поднимать её — это правка боевого бота и деплой в master. Если точности Cloudflare
// не хватит, вариант со своим сервером остаётся открытым.

var CLOCK_SOURCE_URL = 'https://cloudflare.com/cdn-cgi/trace';
var CLOCK_SOURCE_NAME = 'Cloudflare';

// Одна проба: засекли, спросили время, засекли ответ.
async function probeClockOnce() {
  const t0 = Date.now();
  const res = await fetch(CLOCK_SOURCE_URL, { cache: 'no-store', credentials: 'omit' });
  const text = await res.text();
  const t1 = Date.now();

  const m = /^ts=([\d.]+)$/m.exec(text);
  if (!m) throw new Error('эталон ответил не тем форматом');
  const serverMs = Math.round(Number(m[1]) * 1000);
  if (!Number.isFinite(serverMs)) throw new Error('эталон назвал нечисловое время');

  return probeOffset({ t0, serverMs, t1 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Несколько проб подряд, поправка = медиана лучших. Всего 5 запросов по паре сотен байт
// и один раз за открытие панели.
async function syncClock() {
  const probes = [];
  let lastError = null;
  for (let i = 0; i < CLOCK_PROBES; i += 1) {
    try {
      probes.push(await probeClockOnce());
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
    if (i < CLOCK_PROBES - 1) await sleep(CLOCK_PROBE_GAP_MS);
  }

  const sync = mergeProbes(probes);
  sync.source = CLOCK_SOURCE_NAME;
  sync.at = Date.now();
  if (!sync.ok) sync.error = lastError || 'эталон недоступен';
  return sync;
}
