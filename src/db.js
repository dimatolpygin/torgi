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

export default pool;
