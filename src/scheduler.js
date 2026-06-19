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

// Режим долбёжки: повторять задачу с интервалом, пока не вернёт {success:true}
// или не выйдет окно. Для редких сбоев, когда места открываются не в 00:00.
export async function retryUntil(taskFn, { windowMs, intervalMs }) {
  const deadline = Date.now() + windowMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await taskFn(attempt);
    if (res && res.success) return res;
    if (Date.now() >= deadline) {
      logger.warn(`Окно долбёжки исчерпано после ${attempt} попыток (${Math.round(windowMs / 1000)}с)`);
      return res;
    }
    await sleep(intervalMs);
  }
}

// Высокоуровневый планировщик ночной подачи.
// prepareFn — прогрев (логин, состояние) вызывается за leadSeconds до полуночи.
// fireFn — подача в 00:00:00; должна вернуть {success}. При неуспехе — долбёжка.
export async function scheduleMidnightJob({ prepareFn, fireFn, tz = config.timing.timezone, leadSeconds = config.timing.prepareLeadSeconds, retryWindowMs = 4 * 3600_000, retryIntervalMs = 5000 }) {
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

  // Долбёжка при отсутствии даты / сбое
  logger.warn('Подача в 00:00 не удалась — перехожу в режим повторных попыток.');
  const retried = await retryUntil((attempt) => fireFn(ctx, attempt), { windowMs: retryWindowMs, intervalMs: retryIntervalMs });
  return { drift, result: retried };
}

export default scheduleMidnightJob;
