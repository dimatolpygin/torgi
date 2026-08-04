#!/usr/bin/env node
// Stop-хук okplan: не даёт сессии закончиться «наполовину».
// Если в работе этап Вехи 3 и к нему не написан чек-лист для человека
// (docs/uat/ext-N.md) — один раз возвращает сессию доделать хвост.
//
// Защита от петли: при stop_hook_active (нас уже возвращали) — молчим.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  /* нет stdin — работаем без него */
}
let hook = {};
try {
  hook = JSON.parse(input || '{}');
} catch {
  /* не JSON — не беда */
}
if (hook.stop_hook_active) process.exit(0);

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const status = read('docs/STATUS.md');
if (!status) process.exit(0);

const rows = [];
for (const line of status.split('\n')) {
  const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(☐|🚧|✅|⏸)\s*\|\s*`(ext-\d+-done)`/);
  if (m) rows.push({ n: Number(m[1]), title: m[2], mark: m[3], tag: m[4] });
}
const inWork = rows.find((r) => r.mark === '🚧');
if (!inWork) process.exit(0);

let tags = [];
try {
  tags = execSync('git tag -l "ext-*"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
} catch {
  /* не git */
}
if (tags.includes(inWork.tag)) process.exit(0);

const problems = [];
if (!existsSync(`docs/uat/ext-${inWork.n}.md`)) {
  problems.push(`нет чек-листа docs/uat/ext-${inWork.n}.md — человеку нечего проверять`);
}
try {
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (dirty) problems.push('есть незакоммиченные изменения — работа этапа не зафиксирована в git');
} catch {
  /* не git */
}

if (!problems.length) process.exit(0);

console.log(
  JSON.stringify({
    decision: 'block',
    reason:
      `Этап ext-${inWork.n} («${inWork.title}») в работе, но сессия не закончена по okplan: ` +
      problems.join('; ') +
      '. Доделай хвост: короткий чек-лист для человека (≤5 пунктов, простым языком: что сделать и что должно быть видно) ' +
      'в docs/uat/ext-' +
      inWork.n +
      '.md, затем коммит. Тег НЕ ставить — его ставит человек после проверки.',
  }),
);
