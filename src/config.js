import 'dotenv/config';

// Единая точка конфигурации. Значения берутся из окружения (.env / docker-compose).
export const config = {
  // Целевой сайт
  site: {
    baseUrl: process.env.SITE_BASE_URL || 'https://gorod.it-minsk.by',
    // Минский Комаровский рынок
    rinokId: Number(process.env.RINOK_ID || 10),
    // Ассортимент: 1-картофель, 2-овощи, 3-зелень, 4-плоды, 5-ягоды, 6-яблоки
    assortIds: (process.env.ASSORT_IDS || '2').split(',').map((s) => Number(s.trim())),
  },

  // Тайминг подачи
  timing: {
    timezone: process.env.TZ_NAME || 'Europe/Minsk',
    // За сколько секунд до полуночи просыпаться и прогревать сессию
    prepareLeadSeconds: Number(process.env.PREPARE_LEAD_SECONDS || 120),
    // На сколько дней вперёд открывается дата в 00:00 (Комаровский = неделя вперёд).
    // Используется для предвычисления даты брони в прогреве (этап 12).
    bookingLeadDays: Number(process.env.BOOKING_LEAD_DAYS || 7),
    // Сухой прогон: не отправлять реальную заявку
    dryRun: process.env.DRY_RUN !== 'false',
  },

  // Режим долбёжки (опрос при сбоях, когда места открываются не в 00:00).
  // Намеренно консервативно: интервалы как у живого пользователя, чтобы не
  // спровоцировать блокировку нашего единственного IP (fail2ban/mod_evasive).
  retry: {
    windowMs: Number(process.env.RETRY_WINDOW_MS || 4 * 3600_000), // окно 4 часа
    fastIntervalMs: Number(process.env.RETRY_FAST_MS || 4000), // первые минуты — чаще
    fastPhaseMs: Number(process.env.RETRY_FAST_PHASE_MS || 120_000), // длительность «частой» фазы
    slowIntervalMs: Number(process.env.RETRY_SLOW_MS || 20_000), // дальше — реже
    jitterFrac: Number(process.env.RETRY_JITTER || 0.3), // ±30% случайности
    maxPerMinute: Number(process.env.RETRY_MAX_PER_MIN || 15), // жёсткий потолок
    blockStreak: Number(process.env.RETRY_BLOCK_STREAK || 5), // подряд ошибок = тревога
  },

  // Postgres
  pg: {
    host: process.env.PGHOST || 'postgres',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'bron',
    password: process.env.PGPASSWORD || 'bron',
    database: process.env.PGDATABASE || 'bron',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379),
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },
};

export default config;
