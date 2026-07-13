// UAT этап 19: смещение часов сервера сайта относительно НАШИХ (ntp-дисциплинированных)
// часов по заголовку Date, плюс сводка RTT.
//
// Запуск (локально или на сервере/в контейнере):
//   node src/scripts/check-clock.js
//   CLOCK_DURATION_MS=6000 CLOCK_GAP_MS=15 node src/scripts/check-clock.js
//
// На BY-сервере (внутри Docker) Date.now() = часы хоста (ntp, offset <0.1 мс от UTC),
// поэтому измеренное смещение ≈ «часы сайта vs истинный UTC». Гросс-расхождение
// (десятки/сотни мс) означало бы, что часы сайта врут — это учитывается в этапе 20.
//
// Скрипт НИЧЕГО не отправляет на сайт кроме лёгких HEAD-запросов (без тела, без логина).
import { SiteClient } from '../site/client.js';
import { measureSiteClockOffset, formatClockOffset } from '../site/clock.js';
import { logger } from '../logger.js';

async function main() {
  const durationMs = Number(process.env.CLOCK_DURATION_MS || 4000);
  const gapMs = Number(process.env.CLOCK_GAP_MS || 20);
  const maxFlips = Number(process.env.CLOCK_MAX_FLIPS || 5);

  logger.info(`🕐 Замер смещения часов сайта: окно ${durationMs} мс, интервал ${gapMs} мс, до ${maxFlips} переворотов`);
  const client = new SiteClient();
  try {
    const c = await measureSiteClockOffset(client, { durationMs, gapMs, maxFlips });
    logger.info(`Проб: ${c.samples}, переворотов секунды: ${c.flips}`);
    logger.info(`Результат: ${formatClockOffset(c)}`);

    if (c.offsetMs == null) {
      logger.warn('❌ Смещение не измерено (мало проб/переворотов) — увеличьте CLOCK_DURATION_MS.');
      process.exitCode = 1;
    } else if (Math.abs(c.offsetMs) > 500) {
      logger.warn(`⚠ Часы сайта расходятся с нашими на ${c.offsetMs} мс (>500 мс) — стоит учесть в упреждении (этап 20).`);
    } else {
      logger.info('✅ Часы сайта согласованы с нашими в пределах ±0,5 с — систематической форы/потери по времени нет.');
    }
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((e) => {
  logger.error(`Ошибка замера: ${e.stack || e.message}`);
  process.exit(1);
});
