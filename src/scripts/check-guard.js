// UAT-скрипт этапа ext-0: разбор защиты на странице подачи.
// Офлайн, к сайту НЕ ходит — только парсинг образцов HTML и мок-клиент,
// который считает запросы (главный критерий этапа: их число не выросло).
// Запуск: node src/scripts/check-guard.js
import { parseGuard, formatGuard, getRegPage, getRegFields } from '../site/order.js';
import { logger } from '../logger.js';

let failed = 0;
function check(name, ok, detail = '') {
  if (ok) logger.info(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failed += 1;
    logger.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Образцы HTML -----------------------------------------------------------
// 1. То, что клиентка увидела 04.08.2026: блок «Проверка на робота», режим managed.
const HTML_TURNSTILE_MANAGED = `
<form action="/rinki/minsk/create_zajav/" method="post">
  <input type="hidden" name="is_login" value="1">
  <input type="text" name="fam" value="Иванова">
  <div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMYinukE8nzYS" data-appearance="always" data-size="normal"></div>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</form>`;

// 2. Невидимый вариант: виджет создаётся кодом страницы, sitekey — в JS.
const HTML_TURNSTILE_EXPLICIT = `
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<script>turnstile.render('#box', { sitekey: '0x4AAAAAAAZzZz', appearance: 'interaction-only' });</script>
<form><input type="hidden" name="is_login" value="1"></form>`;

// 3. Страница, где виджет уже вставил своё скрытое поле.
const HTML_TOKEN_FIELD = `
<form>
  <div class="cf-turnstile" data-sitekey="0x4AAAAAAAkkk"></div>
  <input type="hidden" name="cf-turnstile-response" value="0.abc123">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
</form>`;

// 4. Как было до 04.08.2026 — никакой защиты.
const HTML_CLEAN = `
<form action="/rinki/minsk/create_zajav/" method="post">
  <input type="hidden" name="is_login" value="1">
  <input type="text" name="t_contakt" value="+375291234567">
</form>`;

// 5. Чужой провайдер — чтобы разбор не считал любую капчу Turnstile'ом.
const HTML_RECAPTCHA = `
<div class="g-recaptcha" data-sitekey="6Lc_aXkUAAAAABBB"></div>
<script src="https://www.google.com/recaptcha/api.js"></script>`;

// --- Разбор -----------------------------------------------------------------
logger.info('--- Разбор образцов HTML ---');

const g1 = parseGuard(HTML_TURNSTILE_MANAGED);
check('managed: провайдер опознан', g1.kind === 'turnstile', `kind=${g1.kind}`);
check('managed: виджет и скрипт видны', g1.widget && g1.script);
check('managed: sitekey вытащен', g1.sitekey === '0x4AAAAAAABkMYinukE8nzYS', g1.sitekey);
check('managed: режим прочитан', g1.appearance === 'always' && g1.size === 'normal', `${g1.appearance}/${g1.size}`);
check(
  'managed: имя поля токена предсказано',
  g1.tokenField === null && g1.tokenFieldExpected === 'cf-turnstile-response',
  `в HTML=${g1.tokenField}, ожидаемое=${g1.tokenFieldExpected}`,
);
logger.info(`   ${formatGuard(g1)}`);

const g2 = parseGuard(HTML_TURNSTILE_EXPLICIT);
check('explicit: sitekey найден в JS-вызове', g2.sitekey === '0x4AAAAAAAZzZz', g2.sitekey);
check('explicit: способ отрисовки распознан', g2.render === 'explicit', g2.render);
logger.info(`   ${formatGuard(g2)}`);

const g3 = parseGuard(HTML_TOKEN_FIELD);
check('поле токена в HTML найдено как есть', g3.tokenField === 'cf-turnstile-response', g3.tokenField);

const g4 = parseGuard(HTML_CLEAN);
check('чистая страница: защиты нет', g4.kind === null && !g4.widget && !g4.script);
check('чистая страница: понятная строка отчёта', /не найдена/.test(formatGuard(g4)), formatGuard(g4));

const g5 = parseGuard(HTML_RECAPTCHA);
check('чужой провайдер не выдаётся за Turnstile', g5.kind === 'recaptcha' && g5.tokenFieldExpected === 'g-recaptcha-response', g5.kind);

check('пустое тело не роняет разбор', parseGuard('').kind === null && parseGuard(undefined).kind === null);

// --- Счётчик запросов -------------------------------------------------------
// Главный критерий этапа: разбор встроен в СУЩЕСТВУЮЩИЙ запрос прогрева,
// число обращений к сайту не выросло.
logger.info('--- Счётчик запросов к сайту ---');

function mockClient() {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      return { status: 200, text: HTML_TURNSTILE_MANAGED };
    },
  };
}

const c1 = mockClient();
const page = await getRegPage(c1);
check('getRegPage делает ровно один GET', c1.calls.length === 1, `запросов: ${c1.calls.length} → ${c1.calls.join(', ')}`);
check('getRegPage отдаёт и поля, и разбор защиты', !!page.fields.is_login && page.guard.kind === 'turnstile');

const c2 = mockClient();
await getRegFields(c2);
check('getRegFields (старый вызов) по-прежнему один GET', c2.calls.length === 1, `запросов: ${c2.calls.length}`);

// --- Итог -------------------------------------------------------------------
if (failed) {
  logger.error(`Проверка не пройдена: ошибок ${failed}`);
  process.exit(1);
}
logger.info('Все проверки этапа ext-0 пройдены.');
