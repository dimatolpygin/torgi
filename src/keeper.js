// Сторож сессий: держит куки кабинетов живыми, чтобы НОЧЬЮ НЕ ТРЕБОВАЛСЯ ЛОГИН.
//
// Зачем. Сайт банит наш IP на час за вход (POST /login/) — воспроизведено вживую
// 31.07.2026: подготовка на восстановленной из Redis сессии проходит чисто, а с полным
// входом обоих кабинетов мгновенно даёт ECONNREFUSED. Ночи 30.07 и 31.07 из-за этого
// потеряны целиком (0 мест из 4): бот логинился в 23:58, ловил бан и в 00:00 стрелял
// в закрытый порт. Причина логина — сессия в Redis жила 12 ч, а между подачами 24 ч,
// поэтому к ночи она всегда протухала.
//
// Что делает. Раз в SESSION_KEEPALIVE_MS дёргает по одному лёгкому запросу на кабинет
// (страница ЛК) — это и продлевает PHP-сессию на сайте, и обновляет TTL куки в Redis.
// Кабинеты разносятся во времени (KEEPER_STAGGER_MS), рядом с полуночью сторож молчит
// (тихое окно), а вход — только через общий пейсер и не чаще loginRetryMs.
import { DateTime } from 'luxon';
import { config } from './config.js';
import { logger } from './logger.js';
import { loadSession, saveSession } from './session.js';
import { restoreSession, loginPaced } from './site/auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Тихое окно вокруг полуночи: в это время сторож не делает НИ ОДНОГО запроса, чтобы
// не добавлять следов в самый чувствительный момент и не мешать подаче.
export function inQuietWindow(now = DateTime.now().setZone(config.timing.timezone)) {
  const { quietBeforeMin, quietAfterMin } = config.timing.keeperQuiet;
  const minutesToMidnight = (24 * 60 - (now.hour * 60 + now.minute)) % (24 * 60);
  const minutesAfterMidnight = now.hour * 60 + now.minute;
  return minutesToMidnight <= quietBeforeMin || minutesAfterMidnight < quietAfterMin;
}

// Один «тик» по кабинету: продлить сессию. Возвращает 'ok' | 'relogin' | 'skip' | 'fail'.
async function touchAccount(account, state) {
  const tag = account.login;
  const saved = await loadSession(tag);

  if (saved) {
    let client;
    try {
      const r = await restoreSession(saved);
      client = r.client;
      if (r.loggedIn) {
        await saveSession(tag, client.cookies); // продлеваем TTL в Redis
        return 'ok';
      }
    } catch (e) {
      logger.warn(`[${tag}] сторож сессий: проверка не удалась (${e.message})`);
      return 'fail';
    } finally {
      await client?.close().catch(() => {});
    }
  }

  // Сессии нет или протухла — нужен вход. Входы редки и разнесены пейсером; чаще, чем
  // раз в loginRetryMs, кабинет не логиним (иначе при бане получим череду входов).
  const now = Date.now();
  if (now - (state.lastLoginTry.get(tag) || 0) < config.timing.keeperLoginRetryMs) return 'skip';
  state.lastLoginTry.set(tag, now);

  try {
    const { client, loggedIn } = await loginPaced(account.login, account.password);
    if (loggedIn) {
      await saveSession(tag, client.cookies);
      logger.info(`[${tag}] сторож сессий: сессия протухла — выполнен вход, кука обновлена`);
    } else {
      logger.warn(`[${tag}] сторож сессий: вход не удался`);
    }
    await client.close().catch(() => {});
    return loggedIn ? 'relogin' : 'fail';
  } catch (e) {
    logger.warn(`[${tag}] сторож сессий: вход не удался (${e.message})`);
    return 'fail';
  }
}

// Запустить сторожа. Возвращает функцию остановки.
export function startSessionKeeper(getAccountsFn) {
  const everyMs = config.timing.sessionKeepaliveMs;
  if (!everyMs) {
    logger.info('🔑 Сторож сессий выключен (SESSION_KEEPALIVE_MS=0) — ночью потребуется вход');
    return () => {};
  }

  const state = { lastLoginTry: new Map() };
  let stopped = false;
  logger.info(
    `🔑 Сторож сессий: продлеваю кабинеты раз в ${Math.round(everyMs / 60000)} мин (вход ночью не потребуется)`,
  );

  (async () => {
    while (!stopped) {
      try {
        if (!inQuietWindow()) {
          for (const account of getAccountsFn()) {
            if (stopped) break;
            const r = await touchAccount(account, state);
            if (r === 'fail') logger.warn(`[${account.login}] сторож сессий: кабинет без живой сессии`);
            await sleep(config.timing.keeperStaggerMs); // кабинеты не бьём одновременно
          }
        }
      } catch (e) {
        logger.warn(`Сторож сессий: сбой цикла (${e.message})`);
      }
      // Спим до следующего тика короткими шагами, чтобы остановка была быстрой.
      for (let slept = 0; slept < everyMs && !stopped; slept += 1000) await sleep(1000);
    }
  })();

  return () => {
    stopped = true;
  };
}

export default startSessionKeeper;
