import { DateTime } from 'luxon';
import { login, restoreSession } from './site/auth.js';
import { SiteClient } from './site/client.js';
import { readMarketState, getTypeMest } from './site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from './site/order.js';
import { getBookings } from './site/bookings.js';
import { loadSession, saveSession, markDone, isDone } from './session.js';
import { waitUntil } from './scheduler.js';
import { config } from './config.js';
import { logger } from './logger.js';

const ACCOUNT_PATH = '/rinki/minsk/account/';

// Логирование с префиксом аккаунта, чтобы в общем потоке было видно, кто что делает.
function alog(tag, msg, level = 'info') {
  logger[level](`[${tag}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Рандомизированная пауза-маскировка перед второй+ заявкой (этап 17). Берём целое
// число мс из [minMs, maxMs] (границы устойчивы к перестановке). 0, если маскировка
// выключена (maxMs<=0). Случайность важна: фикс. разрыв сам по себе оставляет след.
function maskGapMs() {
  const { minMs, maxMs } = config.timing.submitGap;
  if (maxMs <= 0) return 0;
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Маскировка выключена (этап 22: gap=0 → обе заявки в гонку, без паузы).
function gapDisabled() {
  return config.timing.submitGap.maxMs <= 0;
}

// Режим «развязки выстрелов» (этап 23): N мест в гонку, каждое на своём сокете.
// Только боевой режим (dry-run шлёт мгновенно — сокеты не нужны), gap=0 и >1 места.
function placesParallel() {
  return !config.timing.dryRun && gapDisabled() && config.site.bookingsPerAccount > 1;
}

// Сколько тёплых сокетов провизионить на аккаунт: максимум из потребностей
// мультиконнекта (этап 21, K для места №1) и развязки выстрелов (этап 23, по сокету
// на каждое из N мест при gap=0).
function computeSocketsNeeded() {
  const forMulticonnect = config.multiconnect.k;
  const forParallel = placesParallel() ? config.site.bookingsPerAccount : 1;
  return Math.max(1, forMulticonnect, forParallel);
}

// Один выстрел create_zajav: фиксируем метку отправки «от 00:00» (ДО POST — это и есть
// момент, когда заявка ушла) и РЕАЛЬНОЕ время ответа сервера (responseMs). Раньше в
// отчёте была только предотправочная метка, поэтому залип POST (медленный ответ Apache
// в полуночный наплыв) был не виден — метка 1-й заявки показывала «+1 мс», хотя ответ
// пришёл через секунды (баг +8 с 12.07). Исключение POST не валит залп — возвращаем
// отклонённый выстрел с кодом ошибки.
async function fireShot(ctx, client, payload, { dryRun }) {
  const sentMs = ctx.targetMs != null ? Date.now() - ctx.targetMs : null;
  const t0 = Date.now();
  try {
    const sub = await submitOrder(client, payload, { dryRun });
    return { accepted: !!sub.accepted, code: sub.response?.code, sub, sentMs, responseMs: Date.now() - t0 };
  } catch (e) {
    return { accepted: false, code: `err:${e.message}`, error: e, sentMs, responseMs: Date.now() - t0 };
  }
}

// Прогрев аккаунта (этап 12): всё, что можно сделать заранее, чтобы в 00:00 ушёл
// единственный запрос — create_zajav. Заранее тянем поля формы и тип места, и
// кладём предвычисленную дату брони в ctx. Сбой прогрева не критичен — в 00:00
// сработает полный путь (чтение рынка), просто медленнее.
async function warmupAccount(ctx, predicted) {
  const { tag, client } = ctx;
  try {
    const [fields, tm] = await Promise.all([
      getRegFields(client),
      getTypeMest(client, config.site.rinokId),
    ]);
    ctx.fields = fields;
    ctx.defaultType = tm.types[0]?.value ?? 2;
    ctx.predicted = predicted;
    // Прогрев доп-сокетов мультиконнекта (этап 21): устанавливаем TCP/TLS заранее,
    // чтобы в 00:00 гоночный залп ушёл по всем K горячим сокетам за 1 RTT.
    const extras = (ctx.clients || []).slice(1);
    if (extras.length) {
      await Promise.all(extras.map((c) => getRegFields(c).catch(() => {})));
    }
    alog(
      tag,
      `прогрет: поля формы загружены, тип места=${ctx.defaultType}, дата брони (прогноз)=${predicted.dateStr}${extras.length ? `, тёплых соединений=${ctx.clients.length}` : ''} — в 00:00 уйдёт только подача`,
    );
  } catch (e) {
    alog(tag, `прогрев не удался (${e.message}) — в 00:00 пойдёт полный путь`, 'warn');
  }
}

// Прогрев соединения за несколько секунд до 00:00 (этап 14): лёгкий запрос к
// странице подачи «оживляет» TCP/TLS-сокет (если Apache закрыл его за время
// простоя — переустановка происходит здесь, вне критического окна), и заодно
// освежает поля формы. В 00:00 create_zajav уходит по горячему сокету за 1 RTT.
export async function warmConnection(ctx) {
  if (!ctx?.loggedIn || !ctx.client) return;
  const clients = ctx.clients || [ctx.client];
  try {
    // Освежаем поля на основном сокете; доп-сокеты мультиконнекта просто прогреваем
    // (устанавливаем/держим горячим TCP/TLS) и обновляем на них общую куку сессии.
    const fields = await getRegFields(ctx.client);
    ctx.fields = fields;
    if (clients.length > 1) {
      await Promise.all(clients.slice(1).map((c) => getRegFields(c).catch(() => {})));
      for (const c of clients.slice(1)) {
        for (const [k, v] of ctx.client.cookies) c.cookies.set(k, v);
      }
    }
    alog(ctx.tag, `соединени${clients.length > 1 ? `я (${clients.length}) прогреты` : 'е прогрето'} перед 00:00 (поля освежены)`);
  } catch (e) {
    alog(ctx.tag, `прогрев соединения не удался (${e.message}) — выстрел по как есть`, 'warn');
  }
}

// Подготовка аккаунта: вход и создание изолированной сессии (свой SiteClient).
// Сначала пробуем восстановить сессию из Redis (без лишнего логина); если кука
// устарела или её нет — обычный вход, и свежую куку сохраняем в Redis.
// predicted — предвычисленная дата брони {day,month,year,dateStr} для прогрева (этап 12).
export async function prepareAccount(account, { predicted } = {}) {
  const tag = account.login;
  // Подготовка изолирована: сетевой сбой/исключение на одном аккаунте не должен
  // ронять всю ночь (см. prepareAll). При ошибке — безопасный ctx с loggedIn:false.
  try {
    let ctx;

    const saved = await loadSession(tag);
    if (saved) {
      const r = await restoreSession(saved);
      if (r.loggedIn) {
        alog(tag, `сессия восстановлена из Redis (${r.fio || tag}) — логин не потребовался`);
        ctx = { account, tag, client: r.client, loggedIn: true, fio: r.fio, restored: true };
      } else {
        await r.client.close().catch(() => {});
        alog(tag, 'сохранённая сессия устарела — выполняю вход', 'warn');
      }
    }

    if (!ctx) {
      const { client, loggedIn, fio } = await login(account.login, account.password);
      if (loggedIn) {
        await saveSession(tag, client.cookies);
        alog(tag, `сессия готова (${fio || tag}), кука сохранена в Redis`);
      } else {
        alog(tag, 'вход не удался', 'warn');
      }
      ctx = { account, tag, client, loggedIn, fio };
    }

    // Сколько тёплых сокетов держать на аккаунт. Доп-сокеты делят одну сессию (кука
    // gorodid скопирована), но живут на своих TCP-сокетах — как браузер:
    //  - мультиконнект (этап 21): K сокетов для гоночного залпа места №1;
    //  - развязка выстрелов (этап 23): при gap=0 («обе в гонку», этап 22) — по сокету на
    //    КАЖДОЕ место, чтобы залип POST одного места не тормозил остальные. undici.Client —
    //    это одно соединение, параллельные запросы на нём сериализуются; поэтому 2-е место
    //    должно уходить на своём сокете, иначе оно ждёт round-trip 1-го (баг +8 с 12.07).
    ctx.clients = [ctx.client];
    const socketsNeeded = ctx.loggedIn ? computeSocketsNeeded() : 1;
    if (ctx.loggedIn && socketsNeeded > 1) {
      for (let i = 1; i < socketsNeeded; i++) {
        const extra = new SiteClient();
        for (const [k, v] of ctx.client.cookies) extra.cookies.set(k, v);
        ctx.clients.push(extra);
      }
    }

    // Прогрев только для залогиненного аккаунта и когда известна целевая дата.
    if (ctx.loggedIn && predicted) await warmupAccount(ctx, predicted);
    return ctx;
  } catch (e) {
    alog(tag, `подготовка не удалась (${e.message}) — аккаунт пропущен в эту подачу`, 'warn');
    return { account, tag, client: null, loggedIn: false, fio: null, error: e };
  }
}

// Собрать дату YYYY-MM-DD из дня и месяца/года календаря.
function buildDateStr(day, month, year) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

// Подача N мест на одну дату (N = config.site.bookingsPerAccount) + верификация
// числа броней в ЛК. Общая часть для быстрого (00:00) и полного (долбёжка) путей.
async function submitBookings(ctx, attempt, payload, dateStr) {
  const { tag, client } = ctx;
  const n = config.site.bookingsPerAccount;
  const dryRun = config.timing.dryRun;

  // Мультиконнект (этап 21): место №1 гоночным залпом по K сокетам. Приоритетнее развязки
  // ниже: при K>1 работает гоночный залп места №1 (расширение залпа на ОБА места — задача
  // этапа 22). Только боевой режим и когда реально подготовлено >1 соединения.
  if (!dryRun && config.multiconnect.k > 1 && (ctx.clients?.length || 1) > 1) {
    return submitBookingsMulti(ctx, attempt, payload, dateStr, n);
  }

  // Развязка выстрелов (этап 23): обе (N) заявки в гонку без маскировки (gap=0, этап 22)
  // и без мультиконнекта (K=1) — каждая на СВОЁМ тёплом сокете, параллельно, чтобы залип
  // POST одного места не сдвигал остальные (баг +8 с 12.07). Требует N провизионированных
  // сокетов (computeSocketsNeeded).
  if (!dryRun && placesParallel() && n > 1 && (ctx.clients?.length || 1) >= n) {
    return submitBookingsParallel(ctx, attempt, payload, dateStr, n);
  }

  // N заявок = N слотов на одну дату. 1-я уходит сразу в 00:00 (гонка не страдает);
  // каждая следующая — после паузы-маскировки (этап 17), чтобы в утренних списках
  // админов не было «мгновенного дубля» одного имени. Пауза отсчитывается от МОМЕНТА
  // ОТПРАВКИ предыдущей (не её ответа) — видимый разрыв сохраняется, но метка следующей
  // заявки не впитывает round-trip предыдущей. Время каждой заявки «от 00:00» фиксируем
  // (submitTimesMs) для отчёта тайминга жене/мужу/разработчику (этап 18).
  const shots = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const gap = maskGapMs();
      if (gap > 0) {
        alog(tag, `маскировка: пауза ${gap} мс перед заявкой ${i + 1} из ${n}`);
        await sleep(gap);
      }
    }
    shots.push(await fireShot(ctx, client, payload, { dryRun }));
  }
  const submitTimesMs = shots.map((s) => s.sentMs);

  if (dryRun) {
    alog(tag, `попытка ${attempt}: dry-run, собрано ${n} заявк(и) на ${dateStr}`);
    return { tag, success: true, dryRun: true, date: dateStr, count: n, submitTimesMs };
  }

  const subs = shots.map((s) => s.sub || { accepted: s.accepted, response: { code: s.code } });
  const acceptedCount = subs.filter((s) => s.accepted).length;
  if (acceptedCount === 0) {
    // Сервер не принял ничего (нет даты/отклонение) — брони не создано, долбёжка уместна.
    alog(tag, `попытка ${attempt}: сервер отклонил все ${n} (code=${subs[0]?.response?.code})`, 'warn');
    return { tag, success: false, reason: 'rejected', response: subs[0]?.response, date: dateStr, submitTimesMs };
  }

  // Сервер принял заявки (code=201) — они ПОДАНЫ. Это и есть успех: повторную подачу
  // НЕ делаем, иначе при отставании ЛК уйдут дубли (баг ночи 26.06). markDone закрывает
  // долбёжку по дате. Чтение ЛК ниже — только для отчёта (сколько реально подтвердилось).
  await markDone(tag, dateStr);

  // ЛК (страница с десятками броней) сразу после подачи может отставать ИЛИ чтение
  // может сбойнуть (транзиентный сетевой сбой — это и был баг ночи 26.06 у мужа).
  // Проверка ЛК полностью НЕОБЯЗАТЕЛЬНА: ошибка/недобор не отменяет успех (заявки уже
  // приняты сервером) и НЕ запускает повторную подачу. При недоборе — одна перечитка.
  let found = [];
  try {
    found = await findBookings(client, dateStr);
    if (found.length < n && config.timing.verifyRereadMs > 0) {
      await sleep(config.timing.verifyRereadMs);
      found = await findBookings(client, dateStr);
    }
  } catch (e) {
    alog(tag, `чтение ЛК для подтверждения не удалось (${e.message}) — заявки приняты сервером, считаю поданными`, 'warn');
  }

  if (found.length >= n) {
    alog(tag, `✅ подтверждено в ЛК: ${found.length} из ${n} мест на ${dateStr}, ${found[0].market}`);
    return { tag, success: true, date: dateStr, count: found.length, booking: found[0], acceptedCount, submitTimesMs };
  }
  // Приняты сервером, но в ЛК пока меньше — успех (дубли не шлём!). Отчёт честно покажет
  // «принято N, подтверждено M»; клиент при желании добивает вручную.
  alog(
    tag,
    `заявки приняты сайтом (${acceptedCount} из ${n}), в ЛК подтверждено ${found.length} — повтор НЕ делаю (во избежание дублей)`,
    'warn',
  );
  return {
    tag,
    success: true,
    date: dateStr,
    count: Math.max(found.length, acceptedCount),
    confirmed: found.length,
    acceptedCount,
    pendingConfirm: found.length < n,
    booking: found[0],
    submitTimesMs,
  };
}

// Подача с развязкой выстрелов (этап 23): N мест в гонку, каждое место — на СВОЁМ
// тёплом сокете, все N уходят ПАРАЛЛЕЛЬНО (Promise.all). Залип/медленный ответ одного
// сокета не сдвигает метку остальных — тем самым устранён баг «+8 с у 2-й заявки»
// (12.07: 2-я заявка ждала round-trip 1-й на общем сокете). Верификация ЛК — как в
// submitBookings (необязательна; сбой не отменяет успех). Дублей нет: N сокетов = N мест
// (лимит сайта), лишнее (если сервер не срезал) срезаем до N.
async function submitBookingsParallel(ctx, attempt, payload, dateStr, n) {
  const { tag } = ctx;
  const clients = ctx.clients;

  const shots = await Promise.all(
    Array.from({ length: n }, (_, i) => fireShot(ctx, clients[i], payload, { dryRun: false })),
  );
  const submitTimesMs = shots.map((s) => s.sentMs);
  const acceptedCount = shots.filter((s) => s.accepted).length;
  const maxResp = Math.max(0, ...shots.map((s) => s.responseMs ?? 0));
  const spread = shots
    .map((s) => (s.sentMs != null ? `${s.sentMs >= 0 ? '+' : ''}${s.sentMs}` : '—'))
    .join('/');
  alog(
    tag,
    `этап 23: залп ${n} мест по ${n} сокетам параллельно — принято ${acceptedCount}/${n}, отправка [${spread}] мс, макс. ответ ${maxResp} мс`,
  );

  if (acceptedCount === 0) {
    alog(tag, `попытка ${attempt}: сервер отклонил все ${n} (code=${shots[0]?.code})`, 'warn');
    return { tag, success: false, reason: 'rejected', response: { code: shots[0]?.code }, date: dateStr, submitTimesMs, maxResponseMs: maxResp };
  }

  // Приняты сервером = поданы (закрываем долбёжку по дате).
  await markDone(tag, dateStr);

  // Верификация ЛК (необязательна). Если создано БОЛЬШЕ N (сервер не срезал на лимите) —
  // срезаем до N, чтобы в ЛК осталось ровно нужное.
  let found = [];
  try {
    found = await findBookings(ctx.client, dateStr);
    if (found.length < n && config.timing.verifyRereadMs > 0) {
      await sleep(config.timing.verifyRereadMs);
      found = await findBookings(ctx.client, dateStr);
    }
  } catch (e) {
    alog(tag, `чтение ЛК не удалось (${e.message}) — заявки приняты сервером, считаю поданными`, 'warn');
  }
  let cancelled = 0;
  if (found.length > n) {
    cancelled = await cancelExcessBookings(ctx, dateStr, n).catch((e) => {
      alog(tag, `отмена лишних броней не удалась (${e.message}) — проверьте ЛК`, 'warn');
      return 0;
    });
    found = await findBookings(ctx.client, dateStr).catch(() => found);
  }

  const base = { tag, success: true, date: dateStr, acceptedCount, submitTimesMs, maxResponseMs: maxResp, parallel: { n, acceptedCount, maxResponseMs: maxResp, cancelled } };
  if (found.length >= n) {
    alog(tag, `✅ подтверждено в ЛК: ${found.length} из ${n} мест на ${dateStr}, ${found[0].market}`);
    return { ...base, count: found.length, booking: found[0] };
  }
  alog(tag, `этап 23: принято сайтом ${acceptedCount}, в ЛК подтверждено ${found.length} из ${n} — повтор НЕ делаю`, 'warn');
  return {
    ...base,
    count: Math.max(found.length, acceptedCount),
    confirmed: found.length,
    pendingConfirm: found.length < n,
    booking: found[0],
  };
}

// Брони на конкретную дату в ЛК (Комаровский, овощи).
async function findBookings(client, dateStr) {
  const bookings = await getBookings(client);
  return bookings.filter(
    (b) => b.date === dateStr && b.market.includes('Комаровский') && b.assort.includes('овощи'),
  );
}

// Отменить лишние брони на дату, оставив keep штук (этап 21). Гоночный залп мог создать
// больше приёмов, чем нужно (если сервер не срезал на лимите) — снимаем лишнее, чтобы в
// ЛК осталось ровно нужное и не сломалась маскировка. Реверс AJAX: POST account/
// {ID_USER, ACTION:del, LIST}. Возвращает число реально отменённых.
async function cancelExcessBookings(ctx, dateStr, keep) {
  const client = ctx.client;
  const mine = await findBookings(client, dateStr);
  if (mine.length <= keep) return 0;
  const page = await client.get(ACCOUNT_PATH, { followRedirect: true });
  const idUser =
    page.text.match(/name="id_user"[^>]*value="([^"]+)"/i)?.[1] ||
    page.text.match(/id="id_user"[^>]*value="([^"]+)"/i)?.[1];
  if (!idUser) {
    alog(ctx.tag, 'отмена лишних: не нашёл id_user на странице ЛК — оставляю как есть', 'warn');
    return 0;
  }
  const toCancel = mine.slice(keep); // оставить первые keep, отменить остальные
  const LIST = JSON.stringify(Object.fromEntries(toCancel.map((b, i) => [i, String(b.key)])));
  await client.post(
    ACCOUNT_PATH,
    { ID_USER: idUser, ACTION: 'del', LIST },
    { headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://gorod.it-minsk.by' + ACCOUNT_PATH } },
  );
  alog(ctx.tag, `мультиконнект: отменил ${toCancel.length} лишн(юю/их) бронь(и) на ${dateStr} (дубли залпа)`);
  return toCancel.length;
}

// Подача с мультиконнектом (этап 21): место №1 гоночным залпом одинаковой заявки по
// всем K сокетам параллельно — берём ПЕРВЫЙ принятый (min по времени прилёта), лишние
// приёмы гасим отменой (keep=1). Места №2..N — как обычно: маскированные одиночные
// выстрелы на основном сокете. Верификация ЛК — как в submitBookings.
async function submitBookingsMulti(ctx, attempt, payload, dateStr, n) {
  const { tag } = ctx;
  const clients = ctx.clients;
  const K = clients.length;

  // Гоночный залп места №1 по всем K сокетам. Ждём ВСЕ ответы (нужно посчитать приёмы
  // для гашения дублей), но «победитель» = самый быстрый принятый.
  const burst = await Promise.all(
    clients.map(async (client, i) => {
      let sub;
      try {
        sub = await submitOrder(client, payload, { dryRun: false });
      } catch (e) {
        return { i, accepted: false, code: `err:${e.message}`, ms: null };
      }
      return { i, accepted: !!sub.accepted, code: sub.response?.code, ms: ctx.targetMs != null ? Date.now() - ctx.targetMs : null };
    }),
  );
  const accepted = burst.filter((b) => b.accepted).sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9));
  const acceptedCount = accepted.length;
  const winner = accepted[0] || null;
  const submitTimesMs = [winner ? winner.ms : null];
  alog(
    tag,
    `мультиконнект: залп по ${K} сокетам, принято ${acceptedCount}, победитель сокет #${winner ? winner.i : '—'}${winner && winner.ms != null ? ` на ${winner.ms >= 0 ? '+' : ''}${winner.ms} мс` : ''}`,
  );

  if (acceptedCount === 0) {
    alog(tag, `попытка ${attempt}: мультиконнект — сервер отклонил все ${K} (code=${burst[0]?.code})`, 'warn');
    return { tag, success: false, reason: 'rejected', response: { code: burst[0]?.code }, date: dateStr, submitTimesMs, multiconnect: { k: K, acceptedCount: 0, winnerMs: null, cancelled: 0 } };
  }

  // Приняты сервером = поданы (закрываем долбёжку по дате).
  await markDone(tag, dateStr);

  // Гасим лишние приёмы залпа: место №1 — одно. Оставляем 1, остальное отменяем.
  let cancelled = 0;
  if (acceptedCount > 1) {
    cancelled = await cancelExcessBookings(ctx, dateStr, 1).catch((e) => {
      alog(tag, `отмена лишних броней не удалась (${e.message}) — проверьте ЛК`, 'warn');
      return 0;
    });
  }

  // Места №2..N — как обычно: маскированные одиночные выстрелы на основном сокете.
  for (let i = 1; i < n; i++) {
    const gap = maskGapMs();
    if (gap > 0) {
      alog(tag, `маскировка: пауза ${gap} мс перед заявкой ${i + 1} из ${n}`);
      await sleep(gap);
    }
    try {
      await submitOrder(ctx.client, payload, { dryRun: false });
    } catch (e) {
      alog(tag, `заявка ${i + 1} из ${n} не ушла (${e.message})`, 'warn');
    }
    submitTimesMs.push(ctx.targetMs != null ? Date.now() - ctx.targetMs : null);
  }

  // Верификация ЛК (необязательна, как в submitBookings — сбой не отменяет успех).
  let found = [];
  try {
    found = await findBookings(ctx.client, dateStr);
    if (found.length < n && config.timing.verifyRereadMs > 0) {
      await sleep(config.timing.verifyRereadMs);
      found = await findBookings(ctx.client, dateStr);
    }
  } catch (e) {
    alog(tag, `чтение ЛК не удалось (${e.message}) — заявки приняты сервером, считаю поданными`, 'warn');
  }

  const multi = { k: K, acceptedCount, winnerMs: winner.ms, winnerSocket: winner.i, cancelled };
  if (found.length >= n) {
    alog(tag, `✅ подтверждено в ЛК: ${found.length} из ${n} мест на ${dateStr}, ${found[0].market}`);
    return { tag, success: true, date: dateStr, count: found.length, booking: found[0], acceptedCount, submitTimesMs, multiconnect: multi };
  }
  alog(tag, `мультиконнект: принято сайтом, в ЛК подтверждено ${found.length} из ${n} — повтор НЕ делаю`, 'warn');
  return {
    tag,
    success: true,
    date: dateStr,
    count: Math.max(found.length, 1),
    confirmed: found.length,
    acceptedCount,
    pendingConfirm: found.length < n,
    booking: found[0],
    submitTimesMs,
    multiconnect: multi,
  };
}

// Одна попытка подачи для подготовленного аккаунта.
// Возвращает {success, reason, ...}. success=true только при реальном подтверждении
// (или в dry-run, когда запрос собран).
//
// Этап 12: первый выстрел (attempt=1) с прогретым ctx идёт по БЫСТРОМУ пути —
// в 00:00 уходит единственный запрос create_zajav (поля и тип взяты в прогреве,
// дата предвычислена). Если прогрева нет или это долбёжка (attempt>1) — ПОЛНЫЙ путь
// с чтением рынка: так сохраняется поведение «дата ещё не открылась» и коррекция
// прогноза по реальному календарю.
export async function attemptForAccount(ctx, attempt = 1) {
  const { tag, client, loggedIn } = ctx;
  if (!loggedIn) return { tag, success: false, reason: 'not_logged_in' };

  // --- Быстрый путь: только подача (этап 12) ---
  if (attempt === 1 && ctx.fields && ctx.predicted) {
    const { day, month, year, dateStr } = ctx.predicted;
    const payload = buildCreateZajavPayload({
      fields: ctx.fields,
      rinokId: config.site.rinokId,
      typeMesta: ctx.defaultType || 2,
      day,
      month,
      year,
      assortIds: config.site.assortIds,
    });
    // Замер «от 00:00 до подачи»: время от целевой полуночи до отправки запроса.
    const sinceMidnight = ctx.targetMs != null ? Date.now() - ctx.targetMs : null;
    if (sinceMidnight != null) {
      alog(tag, `⏱ от 00:00 до подачи: ${sinceMidnight >= 0 ? '+' : ''}${sinceMidnight} мс (${config.site.bookingsPerAccount} запрос(ов) create_zajav)`);
    }
    let r = await submitBookings(ctx, attempt, payload, dateStr);

    // Безопасный фолбэк упреждения (этап 20): если стреляли РАНЬШЕ 00:00 (send-ahead) и
    // заявка прилетела до открытия даты — сервер вернул отклонение (no_date). Ничего не
    // принято (acceptedCount 0 → дублей нет), поэтому ждём истинную полночь и повторяем
    // подачу один раз без упреждения. Дальше — обычная долбёжка, если и это не прошло.
    if (
      !r.success &&
      r.reason === 'rejected' &&
      ctx.sendAheadMs > 0 &&
      ctx.trueTargetMs != null &&
      Date.now() < ctx.trueTargetMs + 500
    ) {
      alog(tag, 'ранний выстрел отклонён (прилетел до 00:00) — жду полночь и повторяю без упреждения', 'warn');
      await waitUntil(ctx.trueTargetMs);
      r = await submitBookings(ctx, attempt, payload, dateStr);
      r.sendAheadFallback = true;
    }

    if (sinceMidnight != null) r.submitMs = sinceMidnight; // для отчёта тайминга разработчику
    return r;
  }

  // --- Полный путь: чтение рынка → поля → подача (долбёжка / нет прогрева) ---
  const state = await readMarketState(client, config.site.rinokId);
  if (!state.availableDays || state.availableDays.length === 0) {
    alog(tag, `попытка ${attempt}: дат нет`, 'warn');
    return { tag, success: false, reason: 'no_date' };
  }

  const day = state.availableDays[0];
  const dateStr = buildDateStr(day, state.month, state.year);

  // Защита от двойной подачи: на повторных попытках (долбёжка/рестарт) проверяем,
  // не подавали ли уже на эту дату.
  if (attempt > 1 && (await isDone(tag, dateStr))) {
    alog(tag, `на ${dateStr} уже подано ранее — повтор пропущен`);
    return { tag, success: true, date: dateStr, alreadyDone: true };
  }

  const fields = await getRegFields(client);
  const payload = buildCreateZajavPayload({
    fields,
    rinokId: config.site.rinokId,
    typeMesta: state.defaultType || 2,
    day,
    month: state.month,
    year: state.year,
    assortIds: config.site.assortIds,
  });

  return submitBookings(ctx, attempt, payload, dateStr);
}

// Параллельная подготовка всех аккаунтов (изолированные сессии).
// opts.predicted прокидывается в прогрев каждого аккаунта (этап 12).
// allSettled — страховка: даже неожиданное исключение в одном аккаунте не
// отменяет подготовку остальных (prepareAccount и сам не бросает).
export async function prepareAll(accounts, opts = {}) {
  const settled = await Promise.allSettled(accounts.map((a) => prepareAccount(a, opts)));
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { account: accounts[i], tag: accounts[i].login, client: null, loggedIn: false, error: s.reason },
  );
}

// Параллельная подача по всем подготовленным аккаунтам.
export async function attemptAll(contexts, attempt = 1) {
  return Promise.all(contexts.map((ctx) => attemptForAccount(ctx, attempt)));
}

// Закрыть все сессии (включая доп-сокеты мультиконнекта).
export async function closeAll(contexts) {
  await Promise.all(
    contexts.flatMap((ctx) => (ctx.clients || [ctx.client]).map((c) => c?.close().catch(() => {}))),
  );
}

export { buildDateStr };
