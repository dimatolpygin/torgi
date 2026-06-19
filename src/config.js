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
    // Сухой прогон: не отправлять реальную заявку
    dryRun: process.env.DRY_RUN !== 'false',
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
