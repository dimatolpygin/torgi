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

// Загрузить страницу подачи и вернуть предзаполненные поля.
export async function getRegFields(client) {
  const reg = await client.get(REG_PATH, { followRedirect: true });
  return parseFormFields(reg.text);
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
    logger.warn(
      `↳ отказ create_zajav: HTTP ${res.status}` +
        (badFields ? `; поля: ${badFields}` : '') +
        (parsed._raw !== undefined ? `; тело не JSON (${String(parsed._raw).slice(0, 200).replace(/\s+/g, ' ')})` : '') +
        (guard ? `; заголовки: ${guard}` : ''),
    );
  }
  return { dryRun: false, accepted, response: parsed };
}

export default submitOrder;
