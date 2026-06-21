// Боевой E2E (этап 14, пункт 1): РЕАЛЬНАЯ подача create_zajav на тестовом аккаунте.
// DRY_RUN форсится в false независимо от .env. Подаёт на первую доступную дату,
// затем проверяет появление брони в ЛК.
// Запуск: node src/scripts/check-live-submit.js
import { login } from '../site/auth.js';
import { readMarketState } from '../site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from '../site/order.js';
import { verifyBooking } from '../site/bookings.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const pad = (n) => String(n).padStart(2, '0');

async function main() {
  const a = getAccounts()[0];
  const { client, loggedIn, fio } = await login(a.login, a.password);
  if (!loggedIn) { logger.error('Не вошли'); process.exit(1); }
  logger.info(`Вошли как ${fio} (${a.login})`);

  const state = await readMarketState(client, config.site.rinokId);
  const day = state.availableDays[0];
  if (!day) { logger.error('Нет доступных дат — подавать не на что'); process.exit(1); }
  const dateStr = `${state.year}-${pad(state.month)}-${pad(day)}`;
  logger.info(`Подаю на ${dateStr} (рынок=${config.site.rinokId}, тип=${state.defaultType || 2}, ассортимент=${config.site.assortIds.join(',')})`);

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

  const t0 = Date.now();
  const sub = await submitOrder(client, payload, { dryRun: false });
  logger.info(`Ответ за ${Date.now() - t0} мс: ${JSON.stringify(sub.response)}`);
  logger.info(`Принято сервером: ${sub.accepted ? 'ДА' : 'НЕТ'}`);

  const found = await verifyBooking(client, { date: dateStr });
  if (found) {
    logger.info(`✅ ПУНКТ 1: бронь в ЛК подтверждена — ${found.date}, ${found.market}, ${found.placeType}, ${found.assort.join('/')}, key=${found.key}`);
  } else {
    logger.error(`❌ ПУНКТ 1: подача прошла (accepted=${sub.accepted}), но брони на ${dateStr} в ЛК нет`);
  }

  await client.close();
  process.exit(found ? 0 : 1);
}
main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
