import { redis } from './redis.js';
import { logger } from './logger.js';

// Сессионные куки и флаг «сегодня подано» в Redis. При недоступности Redis
// функции мягко деградируют (нет сессии → будет обычный логин).
const SESSION_TTL = Number(process.env.SESSION_TTL_SEC || 12 * 3600); // 12 часов
const DONE_TTL = Number(process.env.DONE_TTL_SEC || 3 * 24 * 3600); // 3 суток

const sessKey = (login) => `bron:sess:${login}`;
const doneKey = (login, date) => `bron:done:${login}:${date}`;

// Сохранить куки сессии (Map или объект) с TTL.
export async function saveSession(login, cookies) {
  const obj = cookies instanceof Map ? Object.fromEntries(cookies) : cookies;
  try {
    await redis.set(sessKey(login), JSON.stringify(obj), 'EX', SESSION_TTL);
  } catch (e) {
    logger.warn(`Не сохранил сессию ${login} в Redis: ${e.message}`);
  }
}

// Загрузить куки сессии. Возвращает объект {имя: значение} или null.
export async function loadSession(login) {
  try {
    const raw = await redis.get(sessKey(login));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    logger.warn(`Не прочитал сессию ${login} из Redis: ${e.message}`);
    return null;
  }
}

export async function clearSession(login) {
  try {
    await redis.del(sessKey(login));
  } catch {
    /* не критично */
  }
}

// Отметить, что по аккаунту на дату уже подано (защита от двойной подачи
// при рестарте/долбёжке). Лимит сайта — 2 заявки/сутки, бот подаёт одну.
export async function markDone(login, date) {
  try {
    await redis.set(doneKey(login, date), '1', 'EX', DONE_TTL);
  } catch {
    /* не критично */
  }
}

export async function isDone(login, date) {
  try {
    return (await redis.get(doneKey(login, date))) === '1';
  } catch {
    return false;
  }
}
