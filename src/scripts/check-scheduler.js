// UAT-скрипт этапа 5: точность тайминга и пропуск понедельника.
// Запуск: node src/scripts/check-scheduler.js
import { DateTime } from 'luxon';
import { fireAt, nextRegistrationMidnight, retryUntil } from '../scheduler.js';
import { logger } from '../logger.js';

async function main() {
  let allOk = true;

  // --- Тест 1: точность выстрела ---
  logger.info('--- Тест 1: точность выстрела (цель через 3 секунды) ---');
  const target = Date.now() + 3000;
  let fired = false;
  const { drift } = await fireAt(target, async () => {
    fired = true;
    return { success: true };
  });
  const accurate = Math.abs(drift) <= 10;
  logger.info(`Отклонение: ${drift} мс — ${accurate ? 'в пределах ±10 мс ✅' : 'СЛИШКОМ МНОГО ❌'}`);
  allOk = allOk && fired && accurate;

  // --- Тест 2: пропуск понедельника ---
  logger.info('--- Тест 2: пропуск понедельника ---');
  // Возьмём воскресенье как точку отсчёта — ближайшая полночь была бы понедельником.
  const sunday = DateTime.fromObject({ year: 2026, month: 6, day: 21, hour: 12 }, { zone: 'Europe/Minsk' });
  logger.info(`Точка отсчёта: ${sunday.toFormat('cccc dd.MM.yyyy')}`);
  const next = nextRegistrationMidnight('Europe/Minsk', sunday);
  logger.info(`Следующая подача: ${next.toFormat('cccc dd.MM.yyyy HH:mm')}`);
  const notMonday = next.weekday !== 1;
  logger.info(notMonday ? 'Понедельник пропущен ✅' : 'Попал на понедельник ❌');
  allOk = allOk && notMonday;

  // --- Тест 3: режим долбёжки до успеха ---
  logger.info('--- Тест 3: долбёжка до успеха ---');
  let n = 0;
  const res = await retryUntil(
    async (attempt) => {
      n = attempt;
      return { success: attempt >= 3 }; // успех на 3-й попытке
    },
    { windowMs: 5000, fastIntervalMs: 30, slowIntervalMs: 30, jitterFrac: 0, maxPerMinute: 1000 },
  );
  const retried = res.success && n === 3;
  logger.info(`Успех на попытке ${n} — ${retried ? '✅' : '❌'}`);
  allOk = allOk && retried;

  // --- Тест 4: потолок запросов в минуту ---
  logger.info('--- Тест 4: потолок запросов (maxPerMinute) ---');
  let calls = 0;
  const t4start = Date.now();
  await retryUntil(
    async () => {
      calls++;
      return { success: false };
    },
    { windowMs: 1500, fastIntervalMs: 1, slowIntervalMs: 1, jitterFrac: 0, maxPerMinute: 5 },
  );
  // за 1.5с с потолком 5/мин не должно успеть больше ~6 запросов
  const capped = calls <= 6;
  logger.info(`Запросов за ${Date.now() - t4start}мс: ${calls} (потолок 5/мин) — ${capped ? '✅' : '❌'}`);
  allOk = allOk && capped;

  // --- Тест 5: тревога о возможной блокировке ---
  logger.info('--- Тест 5: детект блокировки при серии ошибок ---');
  let blockAlert = false;
  await retryUntil(
    async () => {
      throw new Error('ECONNRESET'); // имитация сетевой ошибки
    },
    {
      windowMs: 800,
      fastIntervalMs: 30,
      slowIntervalMs: 30,
      jitterFrac: 0,
      maxPerMinute: 1000,
      blockStreak: 3,
      onPossibleBlock: () => { blockAlert = true; },
    },
  );
  logger.info(`Тревога о блокировке вызвана: ${blockAlert ? 'да ✅' : 'нет ❌'}`);
  allOk = allOk && blockAlert;

  logger.info(allOk ? '✅ Этап 5: тайминг точный, понедельник пропускается, долбёжка безопасна' : '❌ Этап 5: есть проблемы');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
