#!/usr/bin/env node
// Приборная панель Вехи 3: что сделано, что ждёт тебя, где застряло.
// Запуск: node scripts/progress.mjs   (или двойной клик по status.bat)
//
// Ничего не меняет, никуда не ходит по сети — только читает файлы и git.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const git = (cmd) => {
  try {
    // stderr глушим через stdio, а НЕ через `2>/dev/null`: на Windows execSync идёт
    // через cmd.exe, и такой редирект печатает «Системе не удается найти указанный путь».
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const daysAgo = (ts) => Math.floor((Date.now() - ts) / 86400000);

const status = read('docs/STATUS.md');
const roadmap = read('docs/EXT_ROADMAP.md');
if (!status || !roadmap) {
  console.log('Не нахожу docs/STATUS.md или docs/EXT_ROADMAP.md — запускай из папки проекта.');
  process.exit(1);
}

const rows = [];
for (const line of status.split('\n')) {
  const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(☐|🚧|✅|⏸)\s*\|\s*`(ext-\d+-done)`/);
  if (m) rows.push({ n: Number(m[1]), title: m[2], mark: m[3], tag: m[4] });
}
const tags = git('git tag -l "ext-*"').split('\n').filter(Boolean);

// Состояние этапа — по фактам на диске, а не по значку в таблице.
for (const r of rows) {
  r.uat = `docs/uat/ext-${r.n}.md`;
  r.hasUat = existsSync(r.uat);
  r.closed = tags.includes(r.tag);
  r.state = r.closed ? 'ГОТОВО' : r.hasUat ? 'ЖДЁТ ТЕБЯ' : r.mark === '🚧' ? 'В РАБОТЕ' : 'не начат';
  // сколько дней в этом состоянии
  const path = r.hasUat ? r.uat : 'docs/STATUS.md';
  const when = git(`git log -1 --format=%ct -- "${path}"`);
  r.days = when ? daysAgo(Number(when) * 1000) : null;
  if (r.hasUat) {
    try {
      r.uatDays = daysAgo(statSync(r.uat).mtimeMs);
    } catch {
      /* нет файла — не беда */
    }
  }
}

const done = rows.filter((r) => r.closed).length;
const bar = rows.map((r) => (r.closed ? '█' : r.hasUat ? '▓' : r.mark === '🚧' ? '▒' : '░')).join('');

console.log('');
console.log('  ВЕХА 3 · расширение Chrome');
console.log(`  [${bar}]  ${done} из ${rows.length} закрыто`);
console.log('');
for (const r of rows) {
  const icon = r.closed ? '✅' : r.hasUat ? '👀' : r.mark === '🚧' ? '🔨' : '  ';
  const age = !r.closed && r.days !== null && r.days > 0 ? `  (${r.days} дн.)` : '';
  console.log(`  ${icon} ext-${r.n}  ${r.title.padEnd(38)} ${r.state}${age}`);
}

// ── Где застряло ───────────────────────────────────────────────────────────
const alarms = [];
for (const r of rows) {
  if ((r.mark === '✅') !== r.closed) {
    alarms.push(`этап ${r.n}: в таблице «${r.mark}», тег ${r.closed ? 'есть' : 'ОТСУТСТВУЕТ'} — STATUS врёт, чинить первым делом`);
  }
  if (r.hasUat && !r.closed && r.uatDays >= 2) {
    alarms.push(`этап ${r.n}: чек-лист лежит непроверенным ${r.uatDays} дн. — пройди ${r.uat}, потом ok.bat`);
  }
  if (!r.hasUat && r.mark === '🚧' && r.days !== null && r.days >= 2) {
    alarms.push(`этап ${r.n}: «в работе» ${r.days} дн., но чек-листа так и нет — сессия оборвалась, запусти ext.bat`);
  }
}
const dirty = git('git status --porcelain');
if (dirty) alarms.push(`незакоммиченные изменения (${dirty.split('\n').length} файлов) — работа не зафиксирована, git status`);
const ahead = git('git rev-list --count @{u}..HEAD');
if (ahead && ahead !== '0') alarms.push(`${ahead} коммит(ов) не запушено — git push`);

console.log('');
if (alarms.length) {
  console.log('  ⚠ ЗАСТРЯЛО:');
  for (const a of alarms) console.log(`     • ${a}`);
} else {
  console.log('  ✓ Ничего не подвисло: расхождений нет, всё закоммичено и запушено.');
}

// ── Что делать прямо сейчас ────────────────────────────────────────────────
const waiting = rows.find((r) => !r.closed && r.hasUat);
const next = rows.find((r) => !r.closed);
console.log('');
console.log('  ▶ ТВОЙ СЛЕДУЮЩИЙ ШАГ:');
if (waiting) {
  console.log(`     Пройти чек-лист ${waiting.uat} (этап ${waiting.n}), затем запустить ok.bat`);
} else if (next) {
  console.log(`     Запустить ext.bat — возьмётся этап ext-${next.n}: ${next.title}`);
} else {
  console.log('     Веха 3 закрыта целиком.');
}

// ── Хронология ─────────────────────────────────────────────────────────────
const log = git('git log --oneline -5 --date=format:%d.%m --format="%cd  %s"');
if (log) {
  console.log('');
  console.log('  Последние изменения:');
  for (const l of log.split('\n')) console.log(`     ${l.length > 76 ? l.slice(0, 76) + '…' : l}`);
}

console.log('');
console.log('  Ничего не крутится в фоне: сессия работает, только пока открыто окно ext.bat.');
console.log('  Бот на сервере живёт отдельно — его признак жизни это ночное сообщение в Telegram.');
console.log('');
