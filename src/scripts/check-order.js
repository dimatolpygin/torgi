// UAT-скрипт этапа 3: формирование заявки (dry-run).
// Запуск: node src/scripts/check-order.js
import { login } from '../site/auth.js';
import { readMarketState } from '../site/market.js';
import { getRegFields, buildCreateZajavPayload, submitOrder } from '../site/order.js';
import { getAccounts } from '../accounts.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function main() {
  const acc = getAccounts()[0];
  const { client, loggedIn } = await login(acc.login, acc.password);
  if (!loggedIn) {
    logger.error('Не вошли');
    process.exit(1);
  }

  // Предзаполненные поля профиля
  const fields = await getRegFields(client);
  logger.info('--- Предзаполненные поля профиля (reg/fiz) ---');
  logger.info(JSON.stringify(
    {
      n_persn: fields.n_persn, fam: fields.fam, name: fields.name, otc: fields.otc,
      t_contakt: fields.t_contakt, n_mail: fields.n_mail,
      type_person: fields.type_person, is_login: fields.is_login,
    },
    null, 2,
  ));

  // Состояние рынка
  const state = await readMarketState(client, config.site.rinokId);

  // Дата: первая доступная, либо заглушка (днём дат нет — для проверки сборки)
  let day = state.availableDays[0];
  let month = state.month;
  let year = state.year;
  if (day === undefined) {
    const now = new Date();
    day = '__(дат нет, заглушка)__';
    month = month ?? now.getMonth() + 1;
    year = year ?? now.getFullYear();
    logger.warn('Свободных дат нет — собираю запрос с заглушкой даты для проверки структуры.');
  }

  const payload = buildCreateZajavPayload({
    fields,
    rinokId: config.site.rinokId,
    typeMesta: state.defaultType || 2,
    day,
    month,
    year,
    assortIds: config.site.assortIds,
  });

  logger.info('--- Сформированная заявка (dry-run) ---');
  await submitOrder(client, payload, { dryRun: true });

  // Диагностика (PROBE=1): безопасный запрос с ПУСТОЙ датой.
  // Сервер вернёт ошибку валидации и НЕ создаст заявку — так узнаём обязательные поля.
  if (process.env.PROBE === '1') {
    logger.warn('--- ДИАГНОСТИКА: отправка с пустой датой (заявка не создастся) ---');
    const probePayload = { ...payload, arr_date: '{}' };
    const r = await submitOrder(client, probePayload, { dryRun: false });
    logger.info(`Ответ сервера: ${JSON.stringify(r.response)}`);
  }

  await client.close();

  const ok = payload.rinok === '10' && payload.ARR_ASSORT.includes('2') && payload.type_mesta;
  logger.info(ok ? '✅ Этап 3: запрос собран корректно (Комаровский, овощи, торговый ряд)' : '❌ Этап 3: ошибка сборки');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Ошибка: ${err.stack || err.message}`);
  process.exit(1);
});
