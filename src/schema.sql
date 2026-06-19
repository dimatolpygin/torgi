-- Схема bron-bot. Применяется идемпотентно при старте (ensureSchema в db.js).

-- Кабинеты (она и муж).
CREATE TABLE IF NOT EXISTS accounts (
  id         SERIAL PRIMARY KEY,
  login      TEXT UNIQUE NOT NULL,
  fio        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Попытки подачи: одна запись на каждый прогон по аккаунту.
CREATE TABLE IF NOT EXISTS attempts (
  id            BIGSERIAL PRIMARY KEY,
  account_id    INTEGER REFERENCES accounts(id),
  login         TEXT NOT NULL,          -- денормализация: видно аккаунт без джойна
  target_date   DATE,                   -- дата брони, на которую подавали
  success       BOOLEAN NOT NULL,
  reason        TEXT,                   -- причина неуспеха (no_date/rejected/not_verified/...)
  dry_run       BOOLEAN NOT NULL DEFAULT false,
  drift_ms      INTEGER,                -- отклонение выстрела от 00:00:00.000
  attempts_made INTEGER,               -- сколько попыток в долбёжке
  market        TEXT,                   -- из подтверждения в ЛК
  detail        JSONB,                  -- сырой результат/ответ сервера для разбора
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempts_login_date ON attempts (login, target_date);
CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempts (created_at DESC);
