// Сборка заявки create_zajav — порт из бота (src/site/order.js, buildCreateZajavPayload).
// Формируется тот же самый запрос, чтобы расширение и бот подавали одинаково; отличие
// одно и намеренное: расширение добавляет поле токена проверки на робота, потому что
// подаёт из браузера, где проверку прошёл человек.
//
// Здесь ничего не отправляется — только собирается и описывается словами. Отправка — ext-4.

// Константы кабинета клиентки. У бота они в .env (RINOK_ID, ASSORT_IDS, BOOKINGS_PER_ACCOUNT),
// в расширении вшиты: у клиентки один рынок и один ассортимент, настраивать нечего.
var RINOK_ID = 10; // Комаровский рынок
var TYPE_MESTA_DEFAULT = 2; // «Торговый ряд» — дефолт формы на Комаровке
var ASSORT_DEFAULT = [2]; // овощи
var BOOKINGS_PER_ACCOUNT = 2; // лимит кабинета: 2 места в сутки
var CREATE_PATH = '/rinki/minsk/create_zajav/';

var ASSORT_LABELS = { 1: 'картофель', 2: 'овощи', 3: 'зелень', 4: 'плоды', 5: 'ягоды', 6: 'яблоки' };

// Порядок ключей здесь важен: тело кодируется как form-urlencoded в порядке вставки,
// и сверка с ботом идёт побайтово по готовой строке.
function buildCreateZajavPayload(input) {
  const o = input || {};
  const fields = o.fields || {};
  const assortIds = o.assortIds || ASSORT_DEFAULT;

  const PERSN = JSON.stringify({
    n_persn: fields.n_persn || '',
    fam: fields.fam || '',
    name: fields.name || '',
    otc: fields.otc || '',
  });
  const arr_date = JSON.stringify({ 0: String(o.day) });
  const ARR_ASSORT = JSON.stringify(Object.fromEntries(assortIds.map((v, i) => [i, String(v)])));

  return {
    PERSN,
    rinok: String(o.rinokId == null ? RINOK_ID : o.rinokId),
    type_mesta: String(o.typeMesta == null ? TYPE_MESTA_DEFAULT : o.typeMesta),
    arr_date,
    month: String(o.month == null ? '' : o.month),
    year: String(o.year == null ? '' : o.year),
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

// Токен проверки — единственное, чем запрос расширения отличается от запроса бота.
// Отдельной функцией, чтобы сверка с ботом шла по «голому» payload, а добавка была видна.
function withToken(payload, tokenField, token) {
  if (!tokenField || !token) return { ...payload };
  return { ...payload, [tokenField]: token };
}

// Тело POST — ровно как у бота: new URLSearchParams(obj).toString().
function encodeForm(payload) {
  return new URLSearchParams(payload).toString();
}

// Тело для показа в панели. Настоящий токен наружу из страницы не отдаётся (ext-2),
// поэтому в предпросмотре на его месте стоит длина — видно, что поле есть и не пустое.
function previewForm(payload, tokenField, tokenLength) {
  if (!tokenField) return encodeForm(payload);
  // Токен вырезаем, даже если его уже вложили в payload: предпросмотр не должен
  // показывать настоящее значение ни при каком порядке вызовов.
  const clean = { ...payload };
  delete clean[tokenField];
  const value = tokenLength ? `<токен, ${tokenLength} симв.>` : '<токена нет>';
  return `${encodeForm(clean)}&${tokenField}=${value}`;
}

// Названия ассортимента человеку: [2] → «овощи».
function assortText(assortIds) {
  return (assortIds || ASSORT_DEFAULT).map((id) => ASSORT_LABELS[id] || `ассортимент ${id}`).join(', ');
}

// Человеческое описание того, что уйдёт: «подам 2 заявки на субботу, 15 августа, овощи».
// Панель показывает именно это — не JSON, а фразу, которую можно проверить глазами спросонья.
function describePlan(input) {
  const o = input || {};
  const count = o.count == null ? BOOKINGS_PER_ACCOUNT : o.count;
  const d = o.booking;
  const word = count === 1 ? 'заявку' : 'заявки';
  return `Подам ${count} ${word} на ${formatDateRu(d)} — ${assortText(o.assortIds)}`;
}

// Что мешает подать. Проверяется перед выстрелом, но считается и в dry-run, чтобы
// человек увидел проблему заранее, а не в 00:00:00.
function planProblems(input) {
  const o = input || {};
  const problems = [];
  if (!o.account || !o.account.loggedIn) problems.push('кабинет не виден — войдите на сайт');
  if (!o.day) problems.push('нет целевой даты');
  if (!o.hasToken) problems.push('проверка на робота не пройдена');
  if (!o.tokenField) problems.push('поле токена на странице не найдено');
  return problems;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RINOK_ID,
    TYPE_MESTA_DEFAULT,
    ASSORT_DEFAULT,
    BOOKINGS_PER_ACCOUNT,
    CREATE_PATH,
    ASSORT_LABELS,
    buildCreateZajavPayload,
    withToken,
    encodeForm,
    previewForm,
    assortText,
    describePlan,
    planProblems,
  };
}
