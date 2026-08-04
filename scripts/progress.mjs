#!/usr/bin/env node
// Приборная панель Вехи 3: что сделано, что ждёт тебя, где застряло.
// Запуск: node scripts/progress.mjs   (или двойной клик по status.bat)
//
// Ничего не меняет, никуда не ходит по сети — только читает файлы и git.

import { readFileSync, existsSync } from 'node:fs';
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
// ext-N-auto = машинная часть пройдена (ставит автопрогон), ext-N-done = ты подписал.
const checklist = read('docs/uat/CHECKLIST.md');
for (const r of rows) {
  const sec = roadmap.split(/^## /m).find((s) => s.startsWith(`Этап ${r.n} —`)) || '';
  r.gate = (sec.match(/\*\*Гейт:\s*(АВТО|СТОП)\*\*/) || [, 'АВТО'])[1];
  r.auto = tags.includes(`ext-${r.n}-auto`);
  r.closed = tags.includes(r.tag);
  r.hasUat = checklist.includes(`## Этап ext-${r.n} `);
  r.state = r.closed
    ? 'ГОТОВО'
    : r.auto
      ? 'сделано, ждёт твоей подписи'
      : r.mark === '🚧'
        ? 'В РАБОТЕ'
        : r.gate === 'СТОП'
          ? 'нужен ты (ночь/ПК)'
          : 'не начат';
  const path = 'docs/STATUS.md';
  const when = git(`git log -1 --format=%ct -- "${path}"`);
  r.days = when ? daysAgo(Number(when) * 1000) : null;
}

const done = rows.filter((r) => r.closed).length;
const bar = rows.map((r) => (r.closed ? '█' : r.auto ? '▓' : r.mark === '🚧' ? '▒' : '░')).join('');

console.log('');
console.log('  ВЕХА 3 · расширение Chrome');
console.log(`  [${bar}]  ${done} из ${rows.length} закрыто`);
console.log('');
for (const r of rows) {
  const icon = r.closed ? '✅' : r.auto ? '👀' : r.mark === '🚧' ? '🔨' : r.gate === 'СТОП' ? '⏹' : '  ';
  const age = !r.closed && r.days !== null && r.days > 0 ? `  (${r.days} дн.)` : '';
  console.log(`  ${icon} ext-${r.n}  ${r.title.padEnd(38)} ${r.state}${age}`);
}

// ── Где застряло ───────────────────────────────────────────────────────────
const alarms = [];
for (const r of rows) {
  if ((r.mark === '✅') !== r.closed) {
    alarms.push(`этап ${r.n}: в таблице «${r.mark}», тег ${r.closed ? 'есть' : 'ОТСУТСТВУЕТ'} — STATUS врёт, чинить первым делом`);
  }
  if (r.mark === '🚧' && !r.auto && r.days !== null && r.days >= 1) {
    alarms.push(`этап ${r.n}: «в работе» ${r.days} дн. без тега ext-${r.n}-auto — сессия оборвалась, запусти auto.bat`);
  }
  if (r.auto && !r.hasUat) {
    alarms.push(`этап ${r.n}: автопроверки прошли, но блока в CHECKLIST.md нет — тебе нечего проверить`);
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
const nextAuto = rows.find((r) => !r.closed && !r.auto && r.gate !== 'СТОП');
const pending = (checklist.match(/^- \[ \] /gm) || []).length;
const blockedBy = rows.find((r) => !r.closed && !r.auto && r.gate === 'СТОП');
console.log('');
console.log('  ▶ ТВОЙ СЛЕДУЮЩИЙ ШАГ:');
if (nextAuto) {
  console.log(`     Запустить auto.bat — пойдёт с ext-${nextAuto.n} и дальше, пока не упрётся в тебя`);
  if (pending) console.log(`     (попутно уже накопилось ${pending} пункт(ов) на проверку в docs/uat/CHECKLIST.md)`);
} else if (pending) {
  console.log(`     Пройти docs/uat/CHECKLIST.md — ${pending} пункт(ов), затем ok.bat`);
} else if (blockedBy) {
  console.log(`     Машина своё сделала. Дальше нужен ты: ext-${blockedBy.n} — ${blockedBy.title}`);
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
console.log('  Ничего не крутится в фоне: сессии идут, только пока открыто окно auto.bat.');
console.log('  Бот на сервере живёт отдельно — его признак жизни это ночное сообщение в Telegram.');
console.log('');
