import { SiteClient } from './client.js';
import { logger } from '../logger.js';

const ACCOUNT_PATH = '/rinki/minsk/account/';
const LOGIN_PATH = '/rinki/minsk/login/';
const REG_PATH = '/rinki/minsk/reg/fiz/';

// Признак того, что мы залогинены: на странице ЛК есть ссылка выхода,
// а формы логина (поле пароля) — нет.
function isLoggedIn(html) {
  const hasLogout = /\/account\/logout\//i.test(html);
  const hasLoginForm = /name=["']n_pass["']/i.test(html);
  return hasLogout && !hasLoginForm;
}

// Извлечь ФИО. На странице reg/fiz есть явная метка «ФИО: ...».
function extractFio(html) {
  const m = html.match(/ФИО:\s*([А-ЯЁ][а-яёА-ЯЁ\- ]+?)\s*(?:<|\(|Логин|Личный)/u);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// Логин на сайт. Возвращает { client, loggedIn, fio }.
// При успехе client несёт активную сессию (куку gorodid) для дальнейших запросов.
export async function login(loginName, password) {
  const client = new SiteClient();

  // 1. Зайти на страницу ЛК — сервер выдаёт начальную куку gorodid.
  await client.get(ACCOUNT_PATH, { followRedirect: true });

  // 2. Отправить логин/пароль.
  await client.post(LOGIN_PATH, { n_login: loginName, n_pass: password }, { followRedirect: true });

  // 3. Проверить вход по странице ЛК.
  const acc = await client.get(ACCOUNT_PATH, { followRedirect: true });
  const loggedIn = isLoggedIn(acc.text);

  let fio = null;
  if (loggedIn) {
    fio = extractFio(acc.text);
    if (!fio) {
      // ФИО надёжнее всего на форме подачи (есть метка «ФИО:»).
      const reg = await client.get(REG_PATH, { followRedirect: true });
      fio = extractFio(reg.text);
    }
    logger.info(`✅ Вошли как ${fio || loginName} (логин: ${loginName}, кука gorodid: ${client.cookies.has('gorodid') ? 'есть' : 'нет'})`);
  } else {
    logger.warn(`❌ Вход не удался для логина ${loginName} — проверьте данные`);
  }

  return { client, loggedIn, fio };
}

export default login;
