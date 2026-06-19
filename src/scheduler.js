import { DateTime } from 'luxon';
import { logger } from './logger.js';
import { config } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ближайшая полночь (00:00:00.000) по таймзоне.
// Понедельники пропускаются — в ночь на понедельник регистрации нет.
export function nextRegistrationMidnight(tz = config.timing.timezone, from = DateTime.now().setZone(tz)) {
  let target = from.plus({ days: 1 }).startOf('day');
  while (target.weekday === 1) {
    // 1 = понедельник (luxon)
    target = target.plus({ days: 1 });
  }
  return target;
}

// Точное ожидание до epoch-времени (мс).
// Грубо спим setTimeout-ом, последние ~150 мс — активное ожидание (busy-wait)
// для точности ±несколько мс, т.к. setTimeout в Node неточен.
export async function waitUntil(targetMs) {
  for (;;) {
    const diff = targetMs - Date.now();
    if (diff <= 0) return;
    if (diff > 150) {
      await sleep(diff - 120);
    } else {
      while (Date.now() < targetMs) {
        /* активное ожидание на финише */
      }
      return;
    }
  }
}

// Выполнить задачу точно в targetMs. Логирует отклонение выстрела в мс.
export async function fireAt(targetMs, taskFn) {
  await waitUntil(targetMs);
  const drift = Date.now() - targetMs;
  logger.info(`🎯 Выстрел в цель: отклонение ${drift >= 0 ? '+' : ''}${drift} мс`);
  const result = await taskFn();
  return { drift, result };
}

// Интервал со случайным джиттером (±frac), чтобы запросы не были ритмичными.
function jitter(baseMs, frac) {
  return Math.max(500, Math.round(baseMs + (Math.random() * 2 - 1) * baseMs * frac));
}

// Режим долбёжки: повторять задачу, пока не вернёт {success:true} или не выйдет окно.
// Безопасен для единственного IP: адаптивный интервал (первые минуты чаще, затем реже),
// джиттер, жёсткий потолок запросов в минуту, и тревога при серии сетевых ошибок
// (возможная блокировка). taskFn может бросить исключение — считается неуспехом.
export async function retryUntil(taskFn, opts = {}) {
  const {
    windowMs = config.retry.windowMs,
    fastIntervalMs = config.retry.fastIntervalMs,
    fastPhaseMs = config.retry.fastPhaseMs,
    slowIntervalMs = config.retry.slowIntervalMs,
    jitterFrac = config.retry.jitterFrac,
    maxPerMinute = config.retry.maxPerMinute,
    blockStreak = config.retry.blockStreak,
    onPossibleBlock,
  } = opts;

  const start = Date.now();
  const deadline = start + windowMs;
  const recent = []; // временные метки запросов за последнюю минуту
  let attempt = 0;
  let failStreak = 0;

  for (;;) {
    // Потолок: не больше maxPerMinute запросов в скользящую минуту.
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length >= maxPerMinute) {
      await sleep(60_000 - (now - recent[0]) + 50);
      continue;
    }

    attempt++;
    recent.push(Date.now());
    let res;
    try {
      res = await taskFn(attempt);
      failStreak = 0;
    } catch (e) {
      failStreak++;
      res = { success: false, error: e };
      logger.warn(`Попытка ${attempt}: ошибка запроса (${e.message}); подряд ошибок: ${failStreak}`);
      if (failStreak >= blockStreak && onPossibleBlock) {
        onPossibleBlock(failStreak);
      }
    }

    if (res && res.success) return res;
    if (Date.now() >= deadline) {
      logger.warn(`Окно долбёжки исчерпано после ${attempt} попыток (${Math.round(windowMs / 60000)} мин)`);
      return res;
    }

    const inFastPhase = Date.now() - start < fastPhaseMs;
    const base = inFastPhase ? fastIntervalMs : slowIntervalMs;
    await sleep(jitter(base, jitterFrac));
  }
}

// Высокоуровневый планировщик ночной подачи.
// prepareFn — прогрев (логин, состояние) вызывается за leadSeconds до полуночи.
// fireFn — подача в 00:00:00; должна вернуть {success}. При неуспехе — долбёжка.
export async function scheduleMidnightJob({ prepareFn, fireFn, onPossibleBlock, tz = config.timing.timezone, leadSeconds = config.timing.prepareLeadSeconds }) {
  const target = nextRegistrationMidnight(tz);
  const targetMs = target.toMillis();
  logger.info(`Следующая подача: ${target.toFormat('cccc dd.MM.yyyy HH:mm:ss')} (${tz})`);

  // Ждём до момента прогрева
  const prepareAtMs = targetMs - leadSeconds * 1000;
  await waitUntil(prepareAtMs);
  logger.info(`⏰ Прогрев за ${leadSeconds}с до полуночи…`);
  const ctx = prepareFn ? await prepareFn() : {};

  // Точный выстрел
  const { drift, result } = await fireAt(targetMs, () => fireFn(ctx, 1));
  if (result && result.success) return { drift, result };

  // Долбёжка при отсутствии даты / сбое (безопасные интервалы, тревога при блокировке)
  logger.warn('Подача в 00:00 не удалась — перехожу в режим повторных попыток.');
  const retried = await retryUntil((attempt) => fireFn(ctx, attempt), { onPossibleBlock });
  return { drift, result: retried };
}

export default scheduleMidnightJob;
