// UAT этап 21 (LIVE, READ-ONLY): проверить, что K сокетов с ОДНОЙ сессией (кука gorodid)
// реально работают как залогиненные параллельно — ключевое допущение мультиконнекта.
// НИЧЕГО не бронирует: только логин + K параллельных GET формы подачи. Безопасно.
//
// Запуск на сервере/в контейнере: node src/scripts/check-multiconnect-live.js
//   MULTICONNECT_K=4 node src/scripts/check-multiconnect-live.js
import { login } from '../site/auth.js';
import { SiteClient } from '../site/client.js';
import { getRegFields } from '../site/order.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function main() {
  const K = Math.max(2, Number(process.env.MULTICONNECT_K || config.multiconnect.k || 3));
  const a = getAccounts()[0];
  if (!a) { logger.error('Нет аккаунтов (ACCOUNTS пуст)'); process.exit(1); }

  logger.info(`🔌 Мультиконнект LIVE: логинюсь, клонирую сессию на ${K} сокетов, параллельный GET формы (read-only)`);
  const { client, loggedIn, fio } = await login(a.login, a.password);
  if (!loggedIn) { logger.error('Вход не удался'); process.exit(1); }
  logger.info(`Вошли как ${fio || a.login}`);

  // Клонируем сессию (куку) на K-1 доп-сокетов — как в prepareAccount.
  const clients = [client];
  for (let i = 1; i < K; i++) {
    const extra = new SiteClient();
    for (const [k, v] of client.cookies) extra.cookies.set(k, v);
    clients.push(extra);
  }

  // Прогрев (по одному запросу на сокет), затем ЗАМЕР параллельного залпа GET формы.
  await Promise.all(clients.map((c) => getRegFields(c).catch(() => null)));

  const t0 = Date.now();
  const results = await Promise.all(
    clients.map(async (c, i) => {
      const s = Date.now();
      try {
        const fields = await getRegFields(c);
        const loggedInSocket = fields && (fields.is_login === '1' || 'n_persn' in fields);
        return { i, ok: !!loggedInSocket, ms: Date.now() - s, hasLogin: fields?.is_login };
      } catch (e) {
        return { i, ok: false, ms: Date.now() - s, err: e.message };
      }
    }),
  );
  const burstMs = Date.now() - t0;

  let allOk = true;
  for (const r of results) {
    logger.info(`  сокет #${r.i}: ${r.ok ? 'залогинен' : 'НЕ залогинен'} (is_login=${r.hasLogin ?? '—'}), ${r.ms} мс${r.err ? ' err:' + r.err : ''}`);
    if (!r.ok) allOk = false;
  }
  logger.info(`Параллельный залп ${K} GET за ${burstMs} мс (все сокеты одновременно)`);

  await Promise.all(clients.map((c) => c.close().catch(() => {})));

  if (allOk) {
    logger.info('✅ Все K сокетов одной сессии работают залогиненными параллельно — мультиконнект применим');
    process.exit(0);
  }
  logger.error('❌ Не все сокеты залогинены — общая сессия по сокетам не держится, мультиконнект под вопросом');
  process.exit(1);
}

main().catch((e) => { logger.error(e.stack || e.message); process.exit(1); });
