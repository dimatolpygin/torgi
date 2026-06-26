import 'dotenv/config';

// Роли подписчиков Telegram. dev — надмножество (получает всё + состояние сервера).
export const ROLES = ['wife', 'husband', 'dev'];

// Парсинг кодовых слов из env TELEGRAM_CODE_WORDS.
// Формат: "слово:роль:метка" через запятую, напр. "abc:wife:Жена,xyz:dev:Разработчик".
// Метка необязательна. Слово сравнивается регистронезависимо (нижний регистр).
function parseCodeWords(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [word = '', role = '', ...rest] = entry.split(':').map((x) => x.trim());
      return { word: word.toLowerCase(), role, label: rest.join(':') };
    })
    .filter((c) => c.word && ROLES.includes(c.role));
}

// Привязка аккаунта к Telegram-роли — чтобы слать тайминг подачи жене/мужу на ИХ
// собственный кабинет. Формат env ACCOUNT_ROLES: "подстрока_логина:роль" через запятую,
// напр. "4131195:wife,3080391:husband". Логин на сайте меняется по дням, но стабильна
// числовая часть до 'c' — по ней (подстроке) и матчим. Пусто = индивидуальный тайминг
// не шлём (репозиторий публичный — реальные логины держим только в серверном .env).
function parseAccountRoles(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [match = '', role = ''] = entry.split(':').map((x) => x.trim());
      return { match, role };
    })
    .filter((x) => x.match && ROLES.includes(x.role));
}

// Роль аккаунта по его логину (первое совпадение по подстроке). null — не задано.
export function accountRole(login) {
  for (const { match, role } of config.telegram.accountRoles) {
    if (String(login).includes(match)) return role;
  }
  return null;
}

// Единая точка конфигурации. Значения берутся из окружения (.env / docker-compose).
export const config = {
  // Целевой сайт
  site: {
    baseUrl: process.env.SITE_BASE_URL || 'https://gorod.it-minsk.by',
    // Минский Комаровский рынок
    rinokId: Number(process.env.RINOK_ID || 10),
    // Отображаемое имя рынка (для текстов уведомлений)
    marketName: process.env.SITE_MARKET_NAME || 'Минский Комаровский рынок',
    // Ассортимент: 1-картофель, 2-овощи, 3-зелень, 4-плоды, 5-ягоды, 6-яблоки
    assortIds: (process.env.ASSORT_IDS || '2').split(',').map((s) => Number(s.trim())),
    // Сколько мест бронировать на аккаунт за подачу (лимит сайта — 2/дату).
    // 1 — бот берёт одно место (клиент 2-е вручную); 2 — бот забирает обе ячейки.
    bookingsPerAccount: Math.max(1, Number(process.env.BOOKINGS_PER_ACCOUNT || 1)),
  },

  // Тайминг подачи
  timing: {
    timezone: process.env.TZ_NAME || 'Europe/Minsk',
    // За сколько секунд до полуночи просыпаться и прогревать сессию
    prepareLeadSeconds: Number(process.env.PREPARE_LEAD_SECONDS || 120),
    // На сколько дней вперёд открывается дата в 00:00 (Комаровский = неделя вперёд).
    // Используется для предвычисления даты брони в прогреве (этап 12).
    bookingLeadDays: Number(process.env.BOOKING_LEAD_DAYS || 7),
    // За сколько мс до 00:00 «оживить» соединение (этап 14): запрос рядом с полуночью
    // держит TCP/TLS-сокет горячим, чтобы create_zajav ушёл за 1 RTT без переустановки.
    warmAheadMs: Number(process.env.WARM_AHEAD_MS || 4000),
    // Разнос второй+ заявки по времени (этап 17, маскировка): 1-я заявка уходит в 00:00
    // (гонка не страдает), каждая следующая — после паузы в этом диапазоне (мс).
    // По решению клиентки разрыв ФИКСИРОВАННЫЙ — строго 2 с (min=max). Если задать
    // min<max — пауза станет случайной из диапазона. При BOOKINGS_PER_ACCOUNT=1 не влияет.
    submitGap: {
      minMs: Math.max(0, Number(process.env.SUBMIT_GAP_MIN_MS || 2000)),
      maxMs: Math.max(0, Number(process.env.SUBMIT_GAP_MAX_MS || 2000)),
    },
    // Пауза перед ПОВТОРНОЙ вычиткой ЛК (мс), если сразу после подачи там видно
    // меньше мест, чем принял сервер. ЛК отстаёт на секунды — это даёт ему догнать
    // БЕЗ повторной подачи (повторная подача = дубли). 0 — без перечитки.
    verifyRereadMs: Math.max(0, Number(process.env.VERIFY_REREAD_MS || 1500)),
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
    // Кодовые слова для подписки с ролью (см. parseCodeWords).
    codeWords: parseCodeWords(process.env.TELEGRAM_CODE_WORDS),
    // Привязка аккаунт→роль для индивидуального тайминга (см. parseAccountRoles).
    accountRoles: parseAccountRoles(process.env.ACCOUNT_ROLES),
  },

  // Мониторинг сервера (этап 16).
  health: {
    // Pre-flight: слать разработчику «жив, готов к подаче» при ночном прогреве.
    // Отсутствие этого сообщения ~23:58 = бот не дошёл до прогрева.
    preflight: process.env.HEALTH_PREFLIGHT !== 'false',
  },
};

export default config;
