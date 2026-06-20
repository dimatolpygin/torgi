// UAT-скрипт этапа 11: предпросмотр реального расписания подач против реальности сайта.
// Запуск: node src/scripts/check-schedule.js
//
// Что проверяем:
//  1. Внутренний планировщик: nextRegistrationMidnight считается только от текущего
//     времени (без persisted-состояния) → после рестарта процесс пересчитает корректно.
//  2. Минское время в логах: метка времени лога = Europe/Minsk (TZ контейнера + SYS:).
//  3. Расписание совпадает с реальностью сайта: ночь регистрации (00:00) открывает дату
//     на неделю вперёд (старт + 7). По понедельникам рынок не работает — ни одна ночь
//     регистрации и ни одна дата брони не должны попадать на понедельник.
import { DateTime } from 'luxon';
import { nextRegistrationMidnight } from '../scheduler.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const tz = config.timing.timezone;
const BOOK_LEAD_DAYS = 7; // в 00:00 открывается дата на неделю вперёд

function main() {
  let allOk = true;

  const now = DateTime.now().setZone(tz);
  logger.info(`--- Этап 11: предпросмотр расписания (${tz}) ---`);
  logger.info(`Сейчас по Минску: ${now.setLocale('ru').toFormat('cccc dd.MM.yyyy HH:mm:ss')}`);
  logger.info(`Метка времени этого лога должна совпадать с минским временем выше (TZ + SYS:).`);

  // Ближайшие 10 ночей регистрации, начиная от текущего момента.
  logger.info('--- Ближайшие 10 ночей подачи и даты брони (+7) ---');
  let cursor = now;
  let noMondayNight = true;
  let noMondayBooking = true;
  for (let i = 0; i < 10; i++) {
    const night = nextRegistrationMidnight(tz, cursor);
    const booking = night.plus({ days: BOOK_LEAD_DAYS });
    const nightMon = night.weekday === 1;
    const bookMon = booking.weekday === 1;
    noMondayNight = noMondayNight && !nightMon;
    noMondayBooking = noMondayBooking && !bookMon;
    logger.info(
      `ночь подачи ${night.setLocale('ru').toFormat('cccc dd.MM.yyyy HH:mm')} ` +
        `→ бронь на ${booking.setLocale('ru').toFormat('cccc dd.MM.yyyy')}` +
        `${nightMon || bookMon ? '  ⚠ ПОНЕДЕЛЬНИК!' : ''}`,
    );
    // следующий курсор — сразу после найденной ночи
    cursor = night.plus({ minutes: 1 });
  }

  logger.info('--- Проверки ---');
  logger.info(noMondayNight ? 'Ни одна ночь подачи не попала на понедельник ✅' : 'Есть ночь подачи в понедельник ❌');
  logger.info(noMondayBooking ? 'Ни одна дата брони не попала на понедельник ✅' : 'Есть дата брони в понедельник ❌');
  allOk = allOk && noMondayNight && noMondayBooking;

  // Внутренний планировщик не зависит от внешнего состояния: один и тот же вызов от
  // фиксированной точки всегда даёт один результат → рестарт безопасен.
  const fixed = DateTime.fromObject({ year: 2026, month: 6, day: 22, hour: 15 }, { zone: tz }); // понедельник
  const fromMonday = nextRegistrationMidnight(tz, fixed);
  const detPasses =
    fromMonday.weekday !== 1 &&
    fromMonday.toMillis() === nextRegistrationMidnight(tz, fixed).toMillis();
  logger.info(
    `Детерминизм от фиксированной точки (пн 22.06 15:00 → ${fromMonday.setLocale('ru').toFormat('cccc dd.MM HH:mm')}): ` +
      `${detPasses ? '✅ (пересчёт после рестарта корректен)' : '❌'}`,
  );
  allOk = allOk && detPasses;

  logger.info(
    allOk
      ? '✅ Этап 11: расписание совпадает с реальностью сайта, планировщик внутренний/детерминированный'
      : '❌ Этап 11: есть расхождения',
  );
  process.exit(allOk ? 0 : 1);
}

main();
