import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
});

// Проверка подключения к Postgres. Возвращает версию сервера.
export async function checkPostgres() {
  const { rows } = await pool.query('SELECT version() AS version');
  const version = rows[0].version.split(',')[0];
  logger.info(`✅ Postgres подключён: ${version}`);
  return version;
}

// Идемпотентно создаёт схему (CREATE TABLE IF NOT EXISTS из src/schema.sql).
export async function ensureSchema() {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  logger.info('✅ Схема БД готова (accounts, attempts)');
}

// Upsert аккаунта по логину, возвращает id. ФИО обновляем, если узнали новое.
export async function upsertAccount(login, fio) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (login, fio) VALUES ($1, $2)
     ON CONFLICT (login) DO UPDATE SET fio = COALESCE(EXCLUDED.fio, accounts.fio)
     RETURNING id`,
    [login, fio || null],
  );
  return rows[0].id;
}

// Записать попытку подачи. a: {login, fio, targetDate, success, reason, dryRun,
// driftMs, attemptsMade, market, detail}. Возвращает id записи.
export async function recordAttempt(a) {
  const accountId = await upsertAccount(a.login, a.fio);
  const { rows } = await pool.query(
    `INSERT INTO attempts
       (account_id, login, target_date, success, reason, dry_run, drift_ms, attempts_made, market, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      accountId,
      a.login,
      a.targetDate || null,
      Boolean(a.success),
      a.reason || null,
      Boolean(a.dryRun),
      a.driftMs ?? null,
      a.attemptsMade ?? null,
      a.market || null,
      a.detail ? JSON.stringify(a.detail) : null,
    ],
  );
  return rows[0].id;
}

// Последние N попыток (для истории / отладки).
export async function getRecentAttempts(limit = 10) {
  const { rows } = await pool.query(
    `SELECT login, target_date, success, reason, dry_run, drift_ms, market, created_at
       FROM attempts ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export default pool;
