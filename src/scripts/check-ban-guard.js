// UAT: защита от бана IP (после провала ночи 30.07.2026).
// Проверяет ЛОКАЛЬНО, без сети и без сайта:
//  1. Диагностический замер часов/RTT по умолчанию ВЫКЛЮЧЕН (не бьём пачкой перед 00:00).
//  2. Замер, если его включат, физически не может стать пачкой: gapMs не ниже порога,
//     число проб ограничено потолком.
//  3. Долбёжка распознаёт отказ СОЕДИНЕНИЯ (бан IP) и встаёт на cooldown вместо
//     секундных повторов — иначе каждая попытка продлевает бан (в ту ночь их было 399).
//  4. Обычный неуспех («дат нет») предохранитель НЕ трогает — долбёжка работает как раньше.
//  5. Прогрев соединения перед 00:00 не может подвесить выстрел: есть дедлайн.
//
// Запуск: node src/scripts/check-ban-guard.js
import { config } from '../config.js';
import { retryUntil, looksLikeIpBlock } from '../scheduler.js';
import { warmConnection } from '../runner.js';
import { logger } from '../logger.js';

let failed = 0;
const ok = (name) => logger.info(`  ✅ ${name}`);
const bad = (name, detail) => {
  failed++;
  logger.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
};
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

async function main() {
  logger.info('🛡 UAT: защита от бана IP');

  // 1. Замер часов выключен по умолчанию
  check(
    'диагностический замер часов/RTT выключен по умолчанию',
    config.timing.clockProbe === false,
    `clockProbe=${config.timing.clockProbe}`,
  );

  // 2. Замер не может стать пачкой: считаем РЕАЛЬНОЕ число запросов фейк-клиентом
  const { measureSiteClockOffset, measureRtt } = await import('../site/clock.js');
  let calls = 0;
  const fakeClient = {
    async request() {
      calls++;
      // отдаём валидный заголовок Date, чтобы замер шёл штатным путём
      return { headers: { date: new Date(1_800_000_000_000 + calls * 1000).toUTCString() } };
    },
  };
  const t0 = Date.now();
  await measureSiteClockOffset(fakeClient, { durationMs: 1200, gapMs: 1, maxFlips: 99 });
  const clockCalls = calls;
  const elapsed = Date.now() - t0;
  // при gapMs=1 и 1200 мс окна старый код сделал бы ~1000 запросов
  check(
    `замер часов разрежён: ${clockCalls} запрос(ов) за ${elapsed} мс (не пачка)`,
    clockCalls <= 26,
    `${clockCalls} запросов — порог разрежения не сработал`,
  );

  calls = 0;
  await measureRtt(fakeClient, { path: '/x', samples: 50 });
  check(`замер RTT ограничен потолком: ${calls} запрос(ов)`, calls <= 11, `${calls} запросов`);

  // 3. Распознавание бана
  check('ECONNREFUSED опознан как блокировка IP', looksLikeIpBlock(new Error('connect ECONNREFUSED 87.252.228.216:443')));
  check(
    'ошибка быстрого пути (code=err:…ECONNREFUSED) опознана',
    looksLikeIpBlock({ success: false, reason: 'rejected', response: { code: 'err:connect ECONNREFUSED 87.252.228.216:443' } }),
  );
  check('обычный «дат нет» НЕ считается баном', !looksLikeIpBlock({ success: false, reason: 'no_date' }));

  // 4. Долбёжка при бане: cooldown вместо секундных повторов.
  // Окно 3 с, cooldown 2 с, порог 3 отказа → ожидаем ~3 попытки, а не десятки.
  let attempts = 0;
  const r1 = await retryUntil(
    async () => {
      attempts++;
      throw new Error('connect ECONNREFUSED 87.252.228.216:443');
    },
    { windowMs: 3000, fastIntervalMs: 100, fastPhaseMs: 3000, jitterFrac: 0, connBreakStreak: 3, connCooldownMs: 2000, maxPerMinute: 999 },
  );
  check(
    `при бане долбёжка сделала ${attempts} попыт(ку/ки) вместо десятков`,
    attempts <= 5 && r1 && !r1.success,
    `${attempts} попыток`,
  );

  // 5. Обычный неуспех — поведение как раньше: повторы идут своим темпом (пол джиттера
  // 500 мс), предохранитель молчит. За 3 с окна это ~6 попыток, а не 1–2 как при бане.
  let attempts2 = 0;
  await retryUntil(
    async () => {
      attempts2++;
      return { success: false, reason: 'no_date' };
    },
    { windowMs: 3000, fastIntervalMs: 100, fastPhaseMs: 3000, jitterFrac: 0, connBreakStreak: 3, connCooldownMs: 60_000, maxPerMinute: 999 },
  );
  check(`обычный неуспех: долбёжка не встала на cooldown (${attempts2} попыток за 3 с)`, attempts2 >= 5, `${attempts2} попыток`);

  // 6. Дедлайн прогрева: «повисший» сокет не задерживает нас дольше дедлайна
  const hangCtx = {
    tag: 'test',
    loggedIn: true,
    client: { get: () => new Promise(() => {}), cookies: new Map() }, // никогда не ответит
  };
  hangCtx.clients = [hangCtx.client];
  const t1 = Date.now();
  await warmConnection(hangCtx);
  const waited = Date.now() - t1;
  check(
    `прогрев с повисшим сокетом вернулся за ${waited} мс (дедлайн ${config.timing.warmDeadlineMs} мс)`,
    waited < config.timing.warmDeadlineMs + 800,
    `ждали ${waited} мс`,
  );

  if (failed === 0) {
    logger.info('✅ Все проверки пройдены — бот не создаёт пачек запросов и не долбит в бан');
    process.exit(0);
  }
  logger.error(`❌ Провалено проверок: ${failed}`);
  process.exit(1);
}

main().catch((e) => {
  logger.error(`Сбой UAT: ${e.stack || e.message}`);
  process.exit(1);
});
