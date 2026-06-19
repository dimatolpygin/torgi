import { Telegraf } from 'telegraf';
import { DateTime } from 'luxon';
import { redis } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';

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
    await ctx.reply(
      'bron-bot на связи. Этот чат подписан на уведомления о ночной подаче.\n\n' +
        'Каждую ночь после 00:00 пришлю результат: подал / не подал / какое место.\n' +
        'Команда /status — состояние бота и время следующей подачи.',
    );
  });

  // /status — состояние сервера/бота.
  bot.command('status', async (ctx) => {
    logger.info(`👤 @${ctx.from?.username || '—'} (id:${ctx.from?.id}) → /status`);
    await ctx.reply(await formatStatus());
  });

  async function formatStatus() {
    const st = statusProvider ? await statusProvider() : {};
    const lastRun = await getLastRun();
    const lines = ['bron-bot · состояние'];
    if (st.uptimeMs != null) lines.push(`аптайм: ${humanDuration(st.uptimeMs)}`);
    if (st.nextRun) lines.push(`следующая подача: ${st.nextRun}`);
    if (st.accounts != null) lines.push(`аккаунтов: ${st.accounts}`);
    lines.push(`режим: ${st.dryRun ? 'dry-run (тест, заявки не отправляются)' : 'боевой'}`);
    lines.push(`последний прогон: ${lastRun ? lastRun.title : 'ещё не было'}`);
    return lines.join('\n');
  }

  async function notify(text) {
    await sendToAll(text);
  }

  // Алерт об ошибке на торгах — заметный префикс, чтобы клиент среагировал.
  async function alert(text) {
    await sendToAll(`ВНИМАНИЕ\n${text}`);
  }

  // Итог ночной подачи по каждому аккаунту + предупреждение при неуспехе.
  async function notifyRunResult(results, { dryRun = config.timing.dryRun, date } = {}) {
    const okCount = results.filter((r) => r.success).length;
    const lines = [`bron-bot · результат ночной подачи${dryRun ? ' (dry-run)' : ''}`];
    if (date) lines.push(`дата брони: ${date}`);
    lines.push('');
    for (const r of results) {
      lines.push(`Аккаунт ${r.fio || r.tag}`);
      lines.push(`  ${formatOutcome(r)}`);
    }
    const anyFail = okCount < results.length;
    if (anyFail) {
      lines.push('');
      lines.push('Часть заявок не прошла — подайте вручную!');
    }
    await sendToAll(lines.join('\n'));
    await setLastRun({
      at: DateTime.now().setZone(config.timing.timezone).toISO(),
      title: `${date ? date + ' — ' : ''}${anyFail ? 'частично' : 'успех'} (${okCount}/${results.length})`,
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

// Человекочитаемый исход по одному аккаунту.
function formatOutcome(r) {
  if (r.success && r.dryRun) return 'dry-run — заявка корректно собрана';
  if (r.success) {
    const b = r.booking;
    return `подтверждено — место забронировано${b?.market ? ` (${b.market})` : ''}`;
  }
  const reasons = {
    no_date: 'свободных дат не было',
    rejected: 'сервер отклонил заявку',
    not_verified: 'заявка отправлена, но не подтвердилась в ЛК',
    not_logged_in: 'не удалось войти в аккаунт',
    error: 'сетевая ошибка при подаче',
  };
  return `НЕ ПОДАНО — ${reasons[r.reason] || r.reason || 'неизвестная причина'}. Подайте вручную!`;
}

function humanDuration(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

export default createNotifier;
