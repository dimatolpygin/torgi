// Кто сейчас в кабинете — по полям формы подачи. Ничего не запрашивает: сервер сам
// предзаполняет форму данными залогиненного человека (см. CLAUDE.md, «Ключевая механика
// сайта»), поэтому непустое ФИО в форме = сессия клиентки жива и видна расширению.
//
// Чистые функции: на вход обычный объект {имя поля: значение}, никакого DOM — так их
// можно прогнать из node в офлайн-проверке.

// Поля формы reg/fiz + приметы шапки страницы.
//
// ВАЖНО (выяснено 09.08.2026 на живом залогиненном кабинете): сайт **не подставляет ФИО
// в форму** даже вошедшему — `fam`, `name`, `otc`, телефон и почта приходят ПУСТЫМИ, а
// персону сервер берёт из сессии уже в момент подачи (так же работает и бот: он шлёт эти
// поля пустыми, и заявки принимаются). Поэтому судить о входе по ФИО нельзя — с этим
// панель была бы красной всегда. Судим по `is_login=1` и по шапке: там сайт пишет
// «Личный кабинет пользователя <код>» и ссылку «Выход».
function accountFromFields(fields, header) {
  const f = fields || {};
  const h = header || {};
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
    // Код кабинета из шапки. У жены и мужа он разный — по нему человек и различает,
    // в каком профиле Chrome сейчас сидит (этап ext-7).
    cabinetId: String(h.cabinetId || '').trim(),
    personId: val('n_persn'),
    phone: val('t_contakt'),
    email: val('n_mail'),
    typePerson: val('type_person'),
    // Единственный надёжный признак — поле is_login: у анонима его в форме НЕТ вовсе,
    // у вошедшего оно = 1. Ссылку «Выход» сайт держит в разметке всегда (это скрытое
    // окно входа), поэтому судить по ней нельзя — проверено на обеих живых страницах.
    loggedIn: val('is_login') === '1',
  };
}

// Как назвать кабинет в панели. ФИО сайт не даёт, поэтому показываем то, что даёт.
function accountLabel(account) {
  const a = account || {};
  if (!a.loggedIn) return 'не вижу';
  if (a.fio) return a.fio;
  if (a.cabinetId) return `кабинет ${a.cabinetId}`;
  return 'вход выполнен';
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

// Разбор шапки страницы. Отдельной функцией, чтобы её можно было прогнать из node на
// сохранённой странице сайта, а не только в браузере.
// Годится и для видимого текста страницы (браузер), и для сырого HTML (проверки из node):
// теги вырезаются, разделители между словами могут быть любыми — в живой вёрстке там
// стоит <br>, из-за которого «кабинет пользователя» одним пробелом не ищется.
function parseHeader(text) {
  const raw = String(text || '');
  const t = raw.replace(/<[^>]+>/g, ' ');
  const m = /Личный кабинет\s+пользователя\s+([A-Za-z0-9_-]{4,})/i.exec(t);
  // Только код кабинета. Ссылку «Выход» отсюда намеренно не возвращаем: она есть в
  // разметке и у неавторизованного (скрытое окно входа) и признаком входа не является.
  return { cabinetId: m ? m[1] : '' };
}

// Готовность к ночи одной строкой: что мешает подать. Порядок важен — сначала то,
// что человек может починить прямо сейчас.
function readiness(state) {
  const s = state || {};
  if (!s.onSubmitPage) return { ok: false, text: 'Это не страница подачи заявки — откройте форму брони' };
  if (!s.account || !s.account.loggedIn) return { ok: false, text: 'Кабинет не распознан — войдите на сайт и обновите страницу' };
  return { ok: true, text: `Кабинет виден: ${accountLabel(s.account)}` };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { accountFromFields, accountLabel, isSubmitPage, readiness, SUBMIT_FORM_ID, SUBMIT_FIELD_MARKERS, parseHeader };
}
