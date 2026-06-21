// Боевой E2E реального пути «N мест» на ПЕСОЧНИЦЕ (тестовый аккаунт):
// реально подаёт N=BOOKINGS_PER_ACCOUNT заявок на доступную дату, проверяет
// число броней в ЛК, затем СНИМАЕТ созданные брони (полностью обратимо).
// Запуск: ACCOUNTS="1121298c017rb8:607404" BOOKINGS_PER_ACCOUNT=2 node src/scripts/check-live-multi.js
import { login } from '../site/auth.js';
import { readMarketState } from '../site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from '../site/order.js';
import { getBookings } from '../site/bookings.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const pad = (n) => String(n).padStart(2, '0');
const ACCOUNT_PATH = '/rinki/minsk/account/';

async function deleteKeys(client, keys) {
  const page = await client.get(ACCOUNT_PATH, { followRedirect: true });
  const idUser = page.text.match(/name="id_user"[^>]*value="([^"]+)"/i)?.[1];
  if (!idUser) throw new Error('не нашёл id_user');
  const LIST = JSON.stringify(Object.fromEntries(keys.map((k, i) => [i, String(k)])));
  const res = await client.post(ACCOUNT_PATH, { ID_USER: idUser, ACTION: 'del', LIST }, {
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://gorod.it-minsk.by' + ACCOUNT_PATH },
  });
  let p; try { p = JSON.parse(res.text); } catch { p = {}; }
  return p.code === 200 || p.code === '200';
}

async function main() {
  const n = config.site.bookingsPerAccount;
  const a = getAccounts()[0];
  if (!a.login.includes('rb8')) { logger.error(`ЗАЩИТА: это не песочница (${a.login}). Запускать только на тестовом аккаунте.`); process.exit(1); }
  const { client, loggedIn, fio } = await login(a.login, a.password);
  if (!loggedIn) { logger.error('Не вошли'); process.exit(1); }
  logger.info(`Вход OK: ${fio}, цель — ${n} мест`);

  const state = await readMarketState(client, config.site.rinokId);
  const day = state.availableDays[0];
  if (!day) { logger.error('Нет доступной даты'); process.exit(1); }
  const dateStr = `${state.year}-${pad(state.month)}-${pad(day)}`;

  const before = (await getBookings(client)).filter((b) => b.date === dateStr && b.market.includes('Комаровский'));
  logger.info(`Дата ${dateStr}: уже есть ${before.length} бронь(и) на Комаровском (лимит ${state.limit})`);

  const fields = await getRegFields(client);
  const payload = buildCreateZajavPayload({
    fields, rinokId: config.site.rinokId, typeMesta: state.defaultType || 2,
    day, month: state.month, year: state.year, assortIds: config.site.assortIds,
  });

  logger.info(`--- РЕАЛЬНАЯ подача ${n} заявок на ${dateStr} ---`);
  for (let i = 0; i < n; i++) {
    const sub = await submitOrder(client, payload, { dryRun: false });
    logger.info(`  заявка ${i + 1}/${n}: code=${sub.response?.code}, принято=${sub.accepted}`);
  }

  const after = (await getBookings(client)).filter((b) => b.date === dateStr && b.market.includes('Комаровский') && b.assort.includes('овощи'));
  const created = after.filter((b) => !before.some((x) => x.key === b.key));
  logger.info(`В ЛК на ${dateStr} стало ${after.length} (создано ботом: ${created.length}): ключи ${created.map((b) => b.key).join(', ')}`);
  const ok = created.length >= n;
  logger.info(ok ? `✅ Реальный путь ${n} мест подтверждён в ЛК` : `❌ Ожидали ${n}, создано ${created.length}`);

  // Снимаем созданные брони (чистим песочницу).
  if (created.length > 0) {
    const removed = await deleteKeys(client, created.map((b) => b.key));
    const stillThere = (await getBookings(client)).filter((b) => created.some((c) => c.key === b.key));
    logger.info(`Снятие: ответ ${removed ? 'OK' : 'FAIL'}, осталось из созданных: ${stillThere.length}`);
  }

  await client.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
