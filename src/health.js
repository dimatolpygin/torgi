import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';

// Dead-man's switch (этап 16). Бот раз в pingIntervalMs пингует внешний сервис
// (healthchecks.io или совместимый). Пока пинги идут — сервис молчит. Если пинги
// прекратились дольше grace-периода (VPS/процесс умер) — сервис САМ уведомляет
// разработчика, и он же шлёт «снова в строю» при восстановлении. Наблюдатель —
// внешний SaaS, надёжнее нашего VPS: сервер не может сам сообщить о своей смерти.
//
// Уведомления «упал/поднялся» настраиваются в кабинете healthchecks.io (Telegram/
// e-mail) — это вне нашего кода, потому что в момент падения бот уже не работает.
export function startHealthPing() {
  const url = config.health.healthchecksUrl;
  if (!url) {
    logger.warn('HEALTHCHECKS_URL пуст — внешний мониторинг сервера выключен');
    return () => {};
  }

  let alive = true;
  const ping = async () => {
    try {
      await request(url, { method: 'GET', headersTimeout: 10_000, bodyTimeout: 10_000 });
      if (!alive) {
        alive = true;
        logger.info('🟢 healthchecks: пинг снова проходит');
      }
    } catch (e) {
      // Свой пинг не дошёл — это не падение сервера, а сеть/сервис. Просто логируем:
      // если бот реально умрёт, пинги прекратятся и сработает grace на стороне SaaS.
      if (alive) {
        alive = false;
        logger.warn(`healthchecks: пинг не прошёл (${e.message})`);
      }
    }
  };

  ping();
  const id = setInterval(ping, config.health.pingIntervalMs);
  if (id.unref) id.unref(); // не держим процесс живым ради таймера
  logger.info(`✅ Мониторинг сервера активен: пинг healthchecks каждые ${Math.round(config.health.pingIntervalMs / 1000)}с`);
  return () => clearInterval(id);
}

export default startHealthPing;
