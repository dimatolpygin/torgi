import { logger } from '../logger.js';
import { config } from '../config.js';

const REG_PATH = '/rinki/minsk/reg/fiz/';
const CREATE_PATH = '/rinki/minsk/create_zajav/';

// Собрать значения полей формы reg/fiz (input hidden/text). Для залогиненного
// пользователя часть полей персоны (ФИО, телефон, e-mail) предзаполнена.
export function parseFormFields(html) {
  const fields = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? '';
    fields[name] = value;
  }
  return fields;
}

// Разбор защиты на странице подачи (этап ext-0). Никаких новых запросов: разбирается
// РОВНО тот HTML, который бот и так тянет на прогреве в 23:55. Цель — узнать, чем именно
// закрыта форма (04.08.2026 клиентка увидела в ней блок «Проверка на робота»), как
// называется поле токена и какой sitekey у виджета — это вход для расширения (Веха 3).
export function parseGuard(html) {
  const src = html || '';
  const out = {
    kind: null, // 'turnstile' | 'recaptcha' | 'hcaptcha' | null
    widget: false, // есть ли контейнер виджета в разметке
    script: false, // подключён ли скрипт провайдера
    sitekey: null,
    tokenField: null, // имя скрытого поля с токеном, если оно уже есть в HTML
    tokenFieldExpected: null, // как поле будет называться, когда виджет его создаст
    appearance: null, // data-appearance: always | execute | interaction-only
    size: null, // data-size: normal | compact | flexible
    action: null,
    render: null, // 'explicit' — виджет создаётся кодом страницы, иначе авто
  };

  // Скрипты провайдеров.
  if (/challenges\.cloudflare\.com\/turnstile/i.test(src)) {
    out.kind = 'turnstile';
    out.script = true;
  } else if (/(www\.google\.com|www\.recaptcha\.net)\/recaptcha\//i.test(src)) {
    out.kind = 'recaptcha';
    out.script = true;
  } else if (/hcaptcha\.com\/1\/api\.js/i.test(src)) {
    out.kind = 'hcaptcha';
    out.script = true;
  }
  if (/turnstile\/v0\/api\.js[^"']*render=explicit/i.test(src)) out.render = 'explicit';

  // Контейнер виджета: <div class="cf-turnstile" data-sitekey="…" …>
  const widgetTag =
    src.match(/<[a-z]+\b[^>]*class=["'][^"']*\bcf-turnstile\b[^"']*["'][^>]*>/i)?.[0] ||
    src.match(/<[a-z]+\b[^>]*class=["'][^"']*\bg-recaptcha\b[^"']*["'][^>]*>/i)?.[0] ||
    src.match(/<[a-z]+\b[^>]*class=["'][^"']*\bh-captcha\b[^"']*["'][^>]*>/i)?.[0] ||
    null;
  if (widgetTag) {
    out.widget = true;
    if (!out.kind) out.kind = /cf-turnstile/i.test(widgetTag) ? 'turnstile' : /g-recaptcha/i.test(widgetTag) ? 'recaptcha' : 'hcaptcha';
    out.sitekey = widgetTag.match(/\bdata-sitekey=["']([^"']+)["']/i)?.[1] || null;
    out.appearance = widgetTag.match(/\bdata-appearance=["']([^"']+)["']/i)?.[1] || null;
    out.size = widgetTag.match(/\bdata-size=["']([^"']+)["']/i)?.[1] || null;
    out.action = widgetTag.match(/\bdata-action=["']([^"']+)["']/i)?.[1] || null;
  }
  // Sitekey может лежать и в JS-вызове turnstile.render('#el', {sitekey: '0x…'}).
  if (!out.sitekey) {
    const k = src.match(/\bsitekey["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1];
    if (k) {
      out.sitekey = k;
      if (!out.kind) out.kind = 'turnstile';
    }
  }

  // Скрытое поле токена. Виджет Turnstile ВСТАВЛЯЕТ его в форму сам, уже в браузере, —
  // в статическом HTML его может не быть. Поэтому отдельно: что реально найдено в HTML
  // (tokenField) и как поле будет называться (tokenFieldExpected).
  for (const m of src.matchAll(/<input\b[^>]*>/gi)) {
    const name = m[0].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (name && /turnstile|captcha|challenge/i.test(name)) {
      out.tokenField = name;
      break;
    }
  }
  if (out.kind === 'turnstile') out.tokenFieldExpected = out.tokenField || 'cf-turnstile-response';
  else if (out.kind === 'recaptcha') out.tokenFieldExpected = out.tokenField || 'g-recaptcha-response';
  else if (out.kind === 'hcaptcha') out.tokenFieldExpected = out.tokenField || 'h-captcha-response';

  return out;
}

// Однострочное описание защиты для лога и ночного отчёта.
export function formatGuard(guard) {
  if (!guard || !guard.kind) return 'Проверка на робота: не найдена в HTML формы';
  const parts = [];
  parts.push(`виджет ${guard.widget ? 'есть' : 'нет'}`);
  parts.push(`скрипт ${guard.script ? 'есть' : 'нет'}`);
  parts.push(`sitekey=${guard.sitekey || '—'}`);
  parts.push(`поле токена=${guard.tokenField || `${guard.tokenFieldExpected || '—'} (создаётся виджетом в браузере)`}`);
  const mode = [guard.appearance && `appearance=${guard.appearance}`, guard.size && `size=${guard.size}`, guard.render && `render=${guard.render}`]
    .filter(Boolean)
    .join(', ');
  parts.push(`режим: ${mode || 'в HTML не указан (задан при создании sitekey)'}`);
  return `Проверка на робота (${guard.kind}): ${parts.join(', ')}`;
}

// Загрузить страницу подачи ОДНИМ запросом и вернуть поля + разбор защиты.
// Один GET — тот самый, что делался и до этапа ext-0 (см. getRegFields ниже).
export async function getRegPage(client) {
  const reg = await client.get(REG_PATH, { followRedirect: true });
  return { fields: parseFormFields(reg.text), guard: parseGuard(reg.text), html: reg.text };
}

// Загрузить страницу подачи и вернуть предзаполненные поля.
export async function getRegFields(client) {
  const { fields } = await getRegPage(client);
  return fields;
}

// Собрать payload для create_zajav/.
// day/month/year — выбранная дата (из календаря). assortIds — ассортимент (овощи=2).
export function buildCreateZajavPayload({ fields, rinokId, typeMesta, day, month, year, assortIds }) {
  // Персона для физлица — из предзаполненных полей профиля
  const PERSN = JSON.stringify({
    n_persn: fields.n_persn || '',
    fam: fields.fam || '',
    name: fields.name || '',
    otc: fields.otc || '',
  });
  // arr_date: { "0": "день" } — как формирует JS из выбранных дней
  const arr_date = JSON.stringify({ 0: String(day) });
  // ARR_ASSORT: { "0": "2" } — выбранные чекбоксы ассортимента
  const ARR_ASSORT = JSON.stringify(Object.fromEntries(assortIds.map((v, i) => [i, String(v)])));

  return {
    PERSN,
    rinok: String(rinokId),
    type_mesta: String(typeMesta),
    arr_date,
    month: String(month ?? ''),
    year: String(year ?? ''),
    t_contakt: fields.t_contakt || '',
    n_mail: fields.n_mail || '',
    pass: fields.pass || '',
    pass_sub: fields.pass_sub || '',
    ARR_ASSORT,
    type_person: fields.type_person || 'fiz',
    is_login: fields.is_login || '1',
    f_sogl: '1',
  };
}

// Отправить заявку (или показать в dry-run).
export async function submitOrder(client, payload, { dryRun = config.timing.dryRun } = {}) {
  if (dryRun) {
    logger.warn('🟡 DRY-RUN: заявка НЕ отправляется. Сформированный запрос:');
    logger.info(`POST ${CREATE_PATH}`);
    logger.info(JSON.stringify(payload, null, 2));
    return { dryRun: true, payload };
  }

  const res = await client.post(CREATE_PATH, payload, {
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://gorod.it-minsk.by' + REG_PATH,
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = { _raw: res.text };
  }
  // code 200/201 — заявка принята
  const accepted = parsed.code === '200' || parsed.code === '201' || parsed.code === 200 || parsed.code === 201;
  logger.info(`Ответ create_zajav: code=${parsed.code}, принято: ${accepted ? 'да' : 'нет'}`);
  // Разбор отказа. В ночь 04.08.2026 сервер отклонял ВСЁ мгновенно (code=500 за 11 мс,
  // один ответ вообще не JSON), а по логам было видно только «code=500» — понять причину
  // постфактум оказалось нечем. Поэтому при отказе печатаем, ЧТО именно не понравилось
  // серверу: непустые поля-ошибки (`no_date`/`empty`/`no_assort`/`length`), HTTP-статус и
  // признаки защиты (`server`, `cf-ray`, `cf-mitigated`), а для не-JSON — начало тела.
  // Это только логирование: ни одного лишнего запроса к сайту не добавляется.
  if (!accepted) {
    const badFields = Object.entries(parsed)
      .filter(([k, v]) => k !== 'code' && k !== '_raw' && typeof v === 'string' && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const guard = ['server', 'cf-ray', 'cf-mitigated', 'x-sucuri-id', 'retry-after']
      .filter((h) => res.headers?.[h])
      .map((h) => `${h}=${res.headers[h]}`)
      .join(', ');
    // Ночи 06–07.08.2026 показали дыру в этом логе: сервер отвечал `HTTP 200, code=500`,
    // но НИ ОДНОГО непустого поля-ошибки — то есть причину он не называет вовсе, а по логу
    // это было неотличимо от «поля есть, но пустые». Поэтому когда полей нет, печатаем сырое
    // тело ответа целиком (обрезав) — пусть следующая ночь скажет, что в нём на самом деле.
    logger.warn(
      `↳ отказ create_zajav: HTTP ${res.status}` +
        (badFields ? `; поля: ${badFields}` : '') +
        (parsed._raw !== undefined ? `; тело не JSON (${String(parsed._raw).slice(0, 200).replace(/\s+/g, ' ')})` : '') +
        (!badFields && parsed._raw === undefined ? `; тело: ${res.text.slice(0, 300).replace(/\s+/g, ' ')}` : '') +
        (guard ? `; заголовки: ${guard}` : ''),
    );
  }
  return { dryRun: false, accepted, response: parsed };
}

export default submitOrder;
