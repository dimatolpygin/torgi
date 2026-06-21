import { Telegraf } from 'telegraf';
import { DateTime } from 'luxon';
import { redis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { startReply, statusText, runResultText, alertText, bookingDateShort, codeAcceptedReply, codeRejectedReply } from './messages.js';

// Подписчики (chat_id → роль) и последний прогон храним в Redis, чтобы переживали
// перезапуск. Если Redis недоступен (локальный UAT) — фолбэк в память.
// Хэш bron:tg:roles: { chatId: 'wife'|'husband'|'dev' }.
const ROLES_KEY = 'bron:tg:roles';
const LASTRUN_KEY = 'bron:tg:last_run';

// chat_id можно задать заранее через env — это операторские чаты (роль dev),
// чтобы разработчик получал уведомления ещё до первого кодового слова.
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
    notifyDev: noop,
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
  // chatId → роль. Чаты из env — операторские (dev).
  const memorySubs = new Map(envChatIds().map((id) => [id, 'dev']));
  let lastRunCache = null;

  async function addSubscriber(chatId, role) {
    const id = String(chatId);
    memorySubs.set(id, role);
    try {
      await redis.hset(ROLES_KEY, id, role);
    } catch (e) {
      logger.warn(`Redis недоступен, подписчик только в памяти: ${e.message}`);
    }
  }

  // Карта chatId → роль (память + Redis; env-память приоритетна как фолбэк).
  async function roleMap() {
    const map = new Map(memorySubs);
    try {
      const h = await redis.hgetall(ROLES_KEY);
      for (const [id, role] of Object.entries(h)) if (!map.has(id)) map.set(id, role);
    } catch {
      /* Redis недоступен — используем память */
    }
    return map;
  }

  // chatId'ы с ролью из набора roles (null = все роли).
  async function subscribers(roles = null) {
    const map = await roleMap();
    const out = [];
    for (const [id, role] of map) if (!roles || roles.includes(role)) out.push(id);
    return out;
  }

  async function sendTo(roles, text) {
    const ids = await subscribers(roles);
    if (ids.length === 0) {
      logger.warn(`Нет подписчиков Telegram${roles ? ` (роли: ${roles.join(',')})` : ''} — сообщение некому отправить`);
      return;
    }
    await Promise.all(
      ids.map((id) =>
        bot.telegram
          .sendMessage(id, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
          .catch((e) => logger.warn(`Не отправлено в чат ${id}: ${e.message}`)),
      ),
    );
    logger.info(`🤖 Telegram → ${ids.length} получателям${roles ? ` [${roles.join(',')}]` : ''}: ${text.split('\n')[0]}`);
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

  // /start — больше НЕ подписывает: просит ввести кодовое слово (гейт на подписку).
  bot.start(async (ctx) => {
    const u = ctx.from;
    logger.info(`👤 @${u?.username || '—'} (id:${u?.id}, ${u?.first_name}) → /start`);
    await ctx.reply(startReply(), { parse_mode: 'HTML' });
  });

  // /status — состояние сервера/бота.
  bot.command('status', async (ctx) => {
    logger.info(`👤 @${ctx.from?.username || '—'} (id:${ctx.from?.id}) → /status`);
    await ctx.reply(await formatStatus(), { parse_mode: 'HTML' });
  });

  // Любой текст (не команда) трактуем как попытку ввести кодовое слово.
  // Регистрируем ПОСЛЕ команд: для /start и /status сработают их обработчики выше.
  bot.on('text', async (ctx) => {
    const u = ctx.from;
    const raw = (ctx.message.text || '').trim();
    if (raw.startsWith('/')) return; // неизвестная команда — не трактуем как слово
    const word = raw.toLowerCase();
    const match = config.telegram.codeWords.find((c) => c.word === word);
    if (!match) {
      logger.info(`👤 @${u?.username || '—'} (id:${u?.id}) → неверное кодовое слово`);
      await ctx.reply(codeRejectedReply(), { parse_mode: 'HTML' });
      return;
    }
    await addSubscriber(ctx.chat.id, match.role);
    logger.info(
      `👤 @${u?.username || '—'} (id:${u?.id}, ${u?.first_name}) подписался по кодовому слову → роль ${match.role}${match.label ? ` (${match.label})` : ''}`,
    );
    await ctx.reply(codeAcceptedReply(match.label || match.role), { parse_mode: 'HTML' });
  });

  async function formatStatus() {
    const st = statusProvider ? await statusProvider() : {};
    const lastRun = await getLastRun();
    return statusText({ ...st, lastRun });
  }

  // Сообщение всем авторизованным (жена + муж + разработчик).
  async function notify(text) {
    await sendTo(null, text);
  }

  // Сообщение только разработчику (состояние сервера, запуск/остановка).
  async function notifyDev(text) {
    await sendTo(['dev'], text);
  }

  // Алерт об ошибке на торгах — заметный префикс, чтобы клиент среагировал.
  // Идёт всем (муж/жена должны знать, что надо подать вручную).
  async function alert(text) {
    await sendTo(null, alertText(text));
  }

  // Итог ночной подачи по каждому аккаунту + предупреждение при неуспехе. Всем.
  async function notifyRunResult(results, { dryRun = config.timing.dryRun, date } = {}) {
    const okCount = results.filter((r) => r.success).length;
    const anyFail = okCount < results.length;
    await sendTo(null, runResultText(results, { dryRun, date }));
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
    notifyDev,
    alert,
    notifyRunResult,
    setLastRun,
    formatStatus,
    subscribers,
  };
}

export default createNotifier;
