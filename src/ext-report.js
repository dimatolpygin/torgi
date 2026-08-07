// Приёмник итогов от расширения Chrome (Веха 3, этап ext-6).
//
// Зачем: подаёт теперь браузер клиентки, а Telegram-бот живёт на сервере. Чтобы итог
// ночи приходил в тот же чат и тем же языком, что и раньше, расширение шлёт сюда
// короткий подписанный отчёт, а отправку в Telegram делает уже бот своими средствами.
// Токен бота в расширение не кладём никогда — оно живёт на чужом ПК.
//
// Защита простая и достаточная для одного эндпоинта: HMAC-SHA256 по «<время>.<тело>»
// общим секретом + окно давности (старый отчёт нельзя переслать повторно) + потолок на
// размер тела. Секрет — только в серверном .env и в хранилище браузера клиентки.
// Если секрет не задан, служба НЕ поднимается вовсе: открытый порт без проверки хуже,
// чем отсутствие уведомления.
import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { extResultText } from './messages.js';

const MAX_BODY_BYTES = 16 * 1024;
export const SIG_HEADER = 'x-bron-signature';
export const TS_HEADER = 'x-bron-ts';

export function signReport(ts, bodyJson, secret) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${bodyJson}`).digest('hex');
}

// Проверка подписи и давности. Возвращает { ok, error } — без исключений, чтобы
// обработчик запроса оставался линейным.
export function verifyReport({ ts, signature, bodyJson, secret, now = Date.now(), maxAgeMs = 5 * 60_000 }) {
  if (!secret) return { ok: false, error: 'секрет не задан' };
  if (!ts || !signature) return { ok: false, error: 'нет подписи или времени' };

  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, error: 'время не число' };
  // Окно в обе стороны: часы браузера клиентки могут спешить (расширение это и меряет).
  if (Math.abs(now - t) > maxAgeMs) return { ok: false, error: 'отчёт слишком старый или из будущего' };

  const expected = signReport(String(ts), bodyJson, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  // Сравнение постоянного времени: длину сверяем отдельно, иначе timingSafeEqual бросит.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'подпись не сошлась' };
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('тело слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Обработчик запроса отдельно от сервера — так его можно прогнать в тесте без сокета.
export function createExtReportHandler({ notifier, secret, path = '/ext/report', now = () => Date.now() } = {}) {
  return async function handle(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = (req.url || '').split('?')[0];
    if (url !== path) return send(404, { ok: false, error: 'not found' });
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });

    let bodyJson;
    try {
      bodyJson = await readBody(req);
    } catch (e) {
      return send(413, { ok: false, error: e.message });
    }

    const v = verifyReport({
      ts: req.headers[TS_HEADER],
      signature: req.headers[SIG_HEADER],
      bodyJson,
      secret,
      now: now(),
    });
    if (!v.ok) {
      logger.warn(`Отчёт расширения отклонён: ${v.error}`);
      return send(401, { ok: false, error: v.error });
    }

    let report;
    try {
      report = JSON.parse(bodyJson);
    } catch {
      return send(400, { ok: false, error: 'тело не JSON' });
    }

    logger.info(
      `📨 Отчёт расширения: ${report.text || '—'} (кабинет ${report.account?.fio || '—'}, дата ${report.booking?.date || '—'})`,
    );
    // Уведомление вторично: если Telegram недоступен, расширение всё равно должно
    // получить 200 — иначе оно будет считать доставку неудачной и пугать человека.
    try {
      await notifier.notify(extResultText(report));
    } catch (e) {
      logger.warn(`Отчёт принят, но в Telegram не ушёл: ${e.message}`);
    }
    return send(200, { ok: true });
  };
}

// Поднять службу. Возвращает функцию остановки; при выключенной настройке — заглушку.
export function startExtReportServer({ notifier } = {}) {
  const { enabled, secret, port, path } = config.extReport;
  if (!enabled) {
    logger.info('Приёмник отчётов расширения выключен (EXT_REPORT_SECRET не задан)');
    return () => {};
  }
  const server = http.createServer(createExtReportHandler({ notifier, secret, path }));
  server.listen(port, () => logger.info(`📨 Приёмник отчётов расширения слушает :${port}${path}`));
  server.on('error', (e) => logger.error(`Приёмник отчётов расширения не поднялся: ${e.message}`));
  return () => server.close();
}

export default startExtReportServer;
