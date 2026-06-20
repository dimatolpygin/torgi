import { Telegraf } from 'telegraf';
import { DateTime } from 'luxon';
import { redis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { startReply, statusText, runResultText, alertText, bookingDateShort } from './messages.js';

// Подписчики (chat_id) и последний прогон храним в Redis, чтобы переживали
// перезапуск. Если Redis недоступен (локальный UAT) — фолбэк в память.
const SUBS_KEY = 'bron:tg:subscribers';
const LASTRUN_KEY = 'bron:tg:last_run';

// chat_id можно задать заранее через env (например, для сервера до первого /start).
function envChatIds() {
  return (process.env.TELEGRAM_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Заглушка, когда токен не задан: бот просто молчит, а не падает.
function disabledNotifier() {
  const noop = async () => {};
  return {
    enabled: false,
    launch: noop,
    stop: noop,
    notify: noop,
    alert: noop,
    notifyRunResult: noop,
    setLastRun: noop,
    subscribers: async () => [],
  };
}

export function createNotifier({ statusProvider } = {}) {
  const token = config.telegram.botToken;
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN пуст — Telegram-уведомления отключены');
    return disabledNotifier();
  }

  const bot = new Telegraf(token);
  const memorySubs = new Set(envChatIds());
  let lastRunCache = null;

  async function addSubscriber(chatId) {
    const id = String(chatId);
    memorySubs.add(id);
    try {
      await redis.sadd(SUBS_KEY, id);
    } catch (e) {
      logger.warn(`Redis недоступен, подписчик только в памяти: ${e.message}`);
    }
  }

  async function subscribers() {
    const set = new Set(memorySubs);
    try {
      (await redis.smembers(SUBS_KEY)).forEach((x) => set.add(x));
    } catch {
      /* Redis недоступен — используем память */
    }
    return [...set];
  }

  async function sendToAll(text) {
    const ids = await subscribers();
    if (ids.length === 0) {
      logger.warn('Нет подписчиков Telegram — сообщение некому отправить');
      return;
    }
    await Promise.all(
      ids.map((id) =>
        bot.telegram
          .sendMessage(id, text)
          .catch((e) => logger.warn(`Не отправлено в чат ${id}: ${e.message}`)),
      ),
    );
    logger.info(`🤖 Telegram → ${ids.length} получателям: ${text.split('\n')[0]}`);
  }

  async function setLastRun(summary) {
    lastRunCache = summary;
    try {
      await redis.set(LASTRUN_KEY, JSON.stringify(summary));
    } catch {
      /* фолбэк в память */
    }
  }

  async function getLastRun() {
    if (lastRunCache) return lastRunCache;
    try {
      const raw = await redis.get(LASTRUN_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* нет данных */
    }
    return null;
  }

  // /start — регистрация чата для уведомлений (она и муж пишут по разу).
  bot.start(async (ctx) => {
    await addSubscriber(ctx.chat.id);
    const u = ctx.from;
    logger.info(`👤 @${u?.username || '—'} (id:${u?.id}, ${u?.first_name}) → /start`);
    await ctx.reply(startReply());
  });

  // /status — состояние сервера/бота.
  bot.command('status', async (ctx) => {
    logger.info(`👤 @${ctx.from?.username || '—'} (id:${ctx.from?.id}) → /status`);
    await ctx.reply(await formatStatus());
  });

  async function formatStatus() {
    const st = statusProvider ? await statusProvider() : {};
    const lastRun = await getLastRun();
    return statusText({ ...st, lastRun });
  }

  async function notify(text) {
    await sendToAll(text);
  }

  // Алерт об ошибке на торгах — заметный префикс, чтобы клиент среагировал.
  async function alert(text) {
    await sendToAll(alertText(text));
  }

  // Итог ночной подачи по каждому аккаунту + предупреждение при неуспехе.
  async function notifyRunResult(results, { dryRun = config.timing.dryRun, date } = {}) {
    const okCount = results.filter((r) => r.success).length;
    const anyFail = okCount < results.length;
    await sendToAll(runResultText(results, { dryRun, date }));
    await setLastRun({
      at: DateTime.now().setZone(config.timing.timezone).toISO(),
      title: `${date ? bookingDateShort(date) + ' — ' : ''}${anyFail ? 'частично' : 'успех'} (${okCount} из ${results.length})`,
    });
  }

  function launch() {
    // bot.launch() резолвится только при остановке — не ждём его.
    bot.launch().catch((e) => logger.error(`Telegram-бот упал: ${e.message}`));
    logger.info('🤖 Telegram-бот запущен (long polling)');
  }

  function stop(reason = 'shutdown') {
    try {
      bot.stop(reason);
    } catch {
      /* уже остановлен */
    }
  }

  return {
    enabled: true,
    bot,
    launch,
    stop,
    notify,
    alert,
    notifyRunResult,
    setLastRun,
    formatStatus,
    subscribers,
  };
}

export default createNotifier;
