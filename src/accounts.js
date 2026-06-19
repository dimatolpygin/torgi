import { config } from './config.js';

// Парсинг аккаунтов из env ACCOUNTS.
// Формат: "логин1:пароль1,логин2:пароль2" (между аккаунтами — запятая).
export function getAccounts() {
  const raw = process.env.ACCOUNTS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      return {
        login: pair.slice(0, idx).trim(),
        password: pair.slice(idx + 1).trim(),
      };
    })
    .filter((a) => a.login && a.password);
}

export default getAccounts;
