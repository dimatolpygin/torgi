// Кто сейчас в кабинете — по полям формы подачи. Ничего не запрашивает: сервер сам
// предзаполняет форму данными залогиненного человека (см. CLAUDE.md, «Ключевая механика
// сайта»), поэтому непустое ФИО в форме = сессия клиентки жива и видна расширению.
//
// Чистые функции: на вход обычный объект {имя поля: значение}, никакого DOM — так их
// можно прогнать из node в офлайн-проверке.

// Поля формы reg/fiz, из которых бот собирает заявку (src/site/order.js).
function accountFromFields(fields) {
  const f = fields || {};
  const val = (name) => String(f[name] == null ? '' : f[name]).trim();
  const fam = val('fam');
  const name = val('name');
  const otc = val('otc');
  const fio = [fam, name, otc].filter(Boolean).join(' ');
  return {
    fio,
    fam,
    name,
    otc,
    personId: val('n_persn'),
    phone: val('t_contakt'),
    email: val('n_mail'),
    typePerson: val('type_person'),
    // is_login=1 сервер ставит залогиненному. Пустое ФИО при is_login=1 — тоже «не вошли»:
    // подавать заявку от пустой персоны бессмысленно.
    loggedIn: val('is_login') === '1' && fio !== '',
  };
}

// Короткое «Иванова А. П.» — панель узкая, полное ФИО в неё не влезает.
function shortFio(account) {
  if (!account || !account.fio) return '';
  const initials = [account.name, account.otc].filter(Boolean).map((s) => s[0].toUpperCase() + '.');
  return [account.fam, ...initials].filter(Boolean).join(' ') || account.fio;
}

// Страница подачи заявки (а не любая другая страница ЛК). Судить по одному адресу нельзя:
// разделы ЛК живут на соседних путях.
//
// ВАЖНО (выяснено 07.08.2026 на живой странице): форма подачи — это
// `<form id="form_reg" method="POST">` БЕЗ атрибута action. Адрес `create_zajav` в HTML
// вообще не встречается, его подставляет скрипт сайта `/js/rinki/rinki.reg.js`. Поэтому
// распознаём страницу по её собственным полям — они уникальны для формы брони.
var SUBMIT_FORM_ID = 'form_reg';
var SUBMIT_FIELD_MARKERS = ['arr_date', 'type_mesta', 'assort_arr[]'];

function isSubmitPage(url, page) {
  const onPath = /^https:\/\/gorod\.it-minsk\.by\/rinki\/minsk\/reg\//.test(String(url || ''));
  if (!onPath) return false;
  const p = page || {};
  if ((p.formIds || []).includes(SUBMIT_FORM_ID)) return true;
  const names = p.inputNames || [];
  // Запасной путь на случай, если id формы когда-нибудь переименуют: три поля брони
  // вместе на одной странице больше нигде не встречаются.
  return SUBMIT_FIELD_MARKERS.every((n) => names.includes(n));
}

// Готовность к ночи одной строкой: что мешает подать. Порядок важен — сначала то,
// что человек может починить прямо сейчас.
function readiness(state) {
  const s = state || {};
  if (!s.onSubmitPage) return { ok: false, text: 'Это не страница подачи заявки — откройте форму брони' };
  if (!s.account || !s.account.loggedIn) return { ok: false, text: 'Кабинет не распознан — войдите на сайт и обновите страницу' };
  return { ok: true, text: `Кабинет виден: ${s.account.fio}` };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { accountFromFields, shortFio, isSubmitPage, readiness, SUBMIT_FORM_ID, SUBMIT_FIELD_MARKERS };
}
