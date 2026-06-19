import { logger } from '../logger.js';

// Чтение состояния рынка на странице подачи заявки (reg/fiz).
// Эндпоинты и параметры выяснены из rinki.reg.js:
//   type_mest/  POST {RINOK}                -> {KVO_TORG_MASH, KVO_TORG_MEST}
//   limit_mest/ POST {RINOK, TYPE_PERSON}   -> {REZERV_LIMIT}
//   calend/     POST {f_reg, ID_RINKA, TYPE_MEST, DATA_YEAR, DATA_MONTH, DATA_DAY} -> {answer: html}

const BASE = '/rinki/minsk/';

function ajaxHeaders() {
  return {
    'x-requested-with': 'XMLHttpRequest',
    referer: 'https://gorod.it-minsk.by/rinki/minsk/reg/fiz/',
  };
}

async function postJson(client, path, data) {
  const res = await client.post(BASE + path, data, { headers: ajaxHeaders() });
  try {
    return { ...JSON.parse(res.text), _status: res.status };
  } catch {
    return { _raw: res.text, _status: res.status };
  }
}

// Типы мест на рынке. value: 1 — машино-место, 2 — торговый ряд.
export async function getTypeMest(client, rinokId) {
  const r = await postJson(client, 'type_mest/', { RINOK: rinokId });
  const types = [];
  if (Number(r.KVO_TORG_MASH) > 0) types.push({ value: 1, label: 'Машино-место', count: Number(r.KVO_TORG_MASH) });
  if (Number(r.KVO_TORG_MEST) > 0) types.push({ value: 2, label: 'Торговый ряд', count: Number(r.KVO_TORG_MEST) });
  return { types, raw: r };
}

// Лимит броней на день для рынка.
export async function getLimit(client, rinokId, typePerson = 'fiz') {
  const r = await postJson(client, 'limit_mest/', { RINOK: rinokId, TYPE_PERSON: typePerson });
  return { limit: Number(r.REZERV_LIMIT) || 0, raw: r };
}

// Календарь: какие дни доступны для записи.
// Доступный день в html — кликабельный <a class="day" day="N">.
export async function getCalendar(client, rinokId, typeMest = '', { year = '', month = '', day = '' } = {}) {
  const r = await postJson(client, 'calend/', {
    DATA_YEAR: year,
    DATA_MONTH: month,
    DATA_DAY: day,
    f_reg: 1,
    ID_RINKA: rinokId,
    TYPE_MEST: typeMest,
  });
  const html = r.answer || r._raw || '';
  const days = [...html.matchAll(/<a[^>]*class=["']day["'][^>]*day=["'](\d+)["']/gi)].map((m) => Number(m[1]));
  // месяц/год календаря — из скрытых select/inputs в ответе
  const ym = html.match(/name=["']month["'][^>]*value=["'](\d+)["']/i);
  const yy = html.match(/name=["']year["'][^>]*value=["'](\d+)["']/i);
  return {
    availableDays: days,
    month: ym ? Number(ym[1]) : null,
    year: yy ? Number(yy[1]) : null,
    rawHtml: html,
  };
}

// Полное состояние рынка: типы мест, лимит, доступные даты.
export async function readMarketState(client, rinokId) {
  const typeMest = await getTypeMest(client, rinokId);
  const limit = await getLimit(client, rinokId);
  // type_mesta по умолчанию — первый доступный (или пусто, если мест нет)
  const defaultType = typeMest.types[0]?.value ?? '';
  const calendar = await getCalendar(client, rinokId, defaultType);

  const state = {
    rinokId,
    types: typeMest.types,
    defaultType,
    limit: limit.limit,
    availableDays: calendar.availableDays,
    month: calendar.month,
    year: calendar.year,
  };

  if (state.availableDays.length > 0) {
    logger.info(`Рынок ${rinokId}: доступные дни [${state.availableDays.join(', ')}] (${state.month}/${state.year}), типы мест: ${state.types.map((t) => t.label).join(', ') || '—'}, лимит: ${state.limit}`);
  } else {
    logger.info(`Рынок ${rinokId}: свободных дат для записи нет (типы мест: ${state.types.map((t) => t.label).join(', ') || '—'}, лимит: ${state.limit})`);
  }
  return state;
}

export default readMarketState;
