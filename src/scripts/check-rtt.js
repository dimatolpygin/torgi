// UAT этап 20: замер сетевого RTT/джиттера до сайта по горячему keep-alive сокету
// и оценка безопасного упреждения выстрела (send-ahead).
//
// Запуск (лучше на BY-сервере/в контейнере — там реальная сеть до госЦОДа):
//   node src/scripts/check-rtt.js
//   RTT_PROBE_SAMPLES=15 node src/scripts/check-rtt.js
//
// one-way ≈ RTT_min/2 — это ПОТОЛОК безопасного упреждения: стрелять раньше one-way
// нельзя (заявка прилетит до открытия даты в 00:00 → no_date, сработает фолбэк).
// Шлёт только лёгкие HEAD-запросы к статике, ничего не бронирует.
import { SiteClient } from '../site/client.js';
import { measureRtt, formatRtt } from '../site/clock.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function main() {
  const samples = Number(process.env.RTT_PROBE_SAMPLES || config.timing.rttProbeSamples);
  const path = process.env.RTT_PROBE_PATH || config.timing.rttProbePath;
  logger.info(`📡 Замер RTT: путь ${path}, проб ${samples}`);

  const client = new SiteClient();
  try {
    const r = await measureRtt(client, { path, samples });
    logger.info(`Результат: ${formatRtt(r)}`);
    if (r.rttMinMs == null) {
      logger.warn('❌ RTT не измерен (нет ответов) — проверьте доступность сайта.');
      process.exitCode = 1;
      return;
    }
    const configured = config.timing.sendAheadMs;
    logger.info(`Текущее упреждение (SEND_AHEAD_MS): ${configured} мс${configured === 0 ? ' (выключено)' : ''}`);
    if (configured > r.oneWayMs) {
      logger.warn(`⚠ Упреждение ${configured} мс > one-way ${r.oneWayMs.toFixed(1)} мс — заявка рискует прилететь до 00:00 (no_date). Сработает безопасный фолбэк, но место в гонке потеряется.`);
    } else {
      logger.info(`✅ Безопасный потолок упреждения ≈ ${Math.floor(r.oneWayMs)} мс (one-way). Текущее упреждение в пределах нормы.`);
    }
    if (r.jitterMs >= r.oneWayMs) {
      logger.info(`ℹ Джиттер (${r.jitterMs} мс) ≳ one-way (${r.oneWayMs.toFixed(1)} мс): выигрыш упреждения тонет в шуме — главный рычаг гонки не здесь, а в мультиконнекте (этап 21).`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((e) => {
  logger.error(`Ошибка замера RTT: ${e.stack || e.message}`);
  process.exit(1);
});
