// Снятие брони из ЛК (реверс AJAX из rinki.gupr.js):
// POST /rinki/minsk/account/ { ID_USER, ACTION:'del', LIST: {"0":"<key>"} }.
// Запуск: node src/scripts/delete-booking.js <key> [<key2> ...]
import { login } from '../site/auth.js';
import { getBookings } from '../site/bookings.js';
import { getAccounts } from '../accounts.js';
import { logger } from '../logger.js';

const ACCOUNT_PATH = '/rinki/minsk/account/';

async function main() {
  const keys = process.argv.slice(2);
  if (keys.length === 0) { logger.error('Укажи key(и) брони: node src/scripts/delete-booking.js 88033'); process.exit(1); }

  const a = getAccounts()[0];
  const { client, loggedIn } = await login(a.login, a.password);
  if (!loggedIn) { logger.error('Не вошли'); process.exit(1); }

  const page = await client.get(ACCOUNT_PATH, { followRedirect: true });
  const idUser = page.text.match(/id="id_user"\s+name="id_user"\s+value="([^"]+)"/i)?.[1]
    || page.text.match(/name="id_user"[^>]*value="([^"]+)"/i)?.[1];
  if (!idUser) { logger.error('Не нашёл id_user на странице ЛК'); process.exit(1); }
  logger.info(`id_user=${idUser}, удаляю key: ${keys.join(', ')}`);

  const LIST = JSON.stringify(Object.fromEntries(keys.map((k, i) => [i, String(k)])));
  const res = await client.post(ACCOUNT_PATH, { ID_USER: idUser, ACTION: 'del', LIST }, {
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://gorod.it-minsk.by' + ACCOUNT_PATH },
  });
  let parsed; try { parsed = JSON.parse(res.text); } catch { parsed = { _raw: res.text.slice(0, 200) }; }
  logger.info(`Ответ удаления: ${JSON.stringify(parsed)}`);

  const after = await getBookings(client);
  const stillThere = after.filter((b) => keys.includes(b.key));
  logger.info(`Броней в ЛК после: ${after.length}. Из удаляемых остались: ${stillThere.length}`);
  const ok = stillThere.length === 0;
  logger.info(ok ? '✅ Бронь(и) сняты' : '❌ Бронь(и) ещё на месте');

  await client.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
