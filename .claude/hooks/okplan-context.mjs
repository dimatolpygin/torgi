#!/usr/bin/env node
// SessionStart-хук okplan: автоматически выполняет ритуал старта сессии
// (STATUS + git-теги + открытые чекбоксы текущего этапа) и отдаёт результат
// в контекст. Смысл: контекст не гниёт — каждая новая сессия начинается с
// одинакового, машинно-собранного среза правды, а не с пересказа прошлой.
//
// Печатает ТОЛЬКО факты. Если Веха 3 не заведена — молчит (не мешает работе по боту).

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const status = read('docs/STATUS.md');
const roadmap = read('docs/EXT_ROADMAP.md');
if (!status || !roadmap) process.exit(0);

// Строки таблицы Вехи 3: | 0  | Название | ☐ | `ext-0-done` | ... |
const rows = [];
for (const line of status.split('\n')) {
  const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(☐|🚧|✅|⏸)\s*\|\s*`(ext-\d+-done)`/);
  if (m) rows.push({ n: Number(m[1]), title: m[2], mark: m[3], tag: m[4] });
}
if (!rows.length) process.exit(0);

let tags = [];
try {
  tags = execSync('git tag -l "ext-*"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
} catch {
  /* не git-репозиторий — не беда */
}

// Правда о закрытии — тег, а не значок в таблице (приоритет okplan: тег > чекбокс > проза).
const closed = rows.filter((r) => tags.includes(r.tag));
const mismatch = rows.filter((r) => (r.mark === '✅') !== tags.includes(r.tag));
const current = rows.find((r) => r.mark === '🚧' && !tags.includes(r.tag)) || rows.find((r) => !tags.includes(r.tag));

const out = [];
out.push('=== okplan · Веха 3 (расширение Chrome) — срез на старте сессии ===');
out.push(`Закрыто этапов: ${closed.length} из ${rows.length}${closed.length ? ' (' + closed.map((r) => r.n).join(', ') + ')' : ''}`);

if (mismatch.length) {
  out.push('');
  out.push('⚠ РАСХОЖДЕНИЕ таблицы STATUS с git-тегами — сначала чинить STATUS, потом работать:');
  for (const r of mismatch) {
    out.push(`   этап ${r.n}: в таблице «${r.mark}», тег ${r.tag} ${tags.includes(r.tag) ? 'ЕСТЬ' : 'отсутствует'}`);
  }
}

if (!current) {
  out.push('');
  out.push('Все этапы Вехи 3 закрыты тегами. Новых работ по расширению нет.');
} else {
  out.push('');
  out.push(`ТЕКУЩИЙ ЭТАП: ext-${current.n} — ${current.title} (${current.mark === '🚧' ? 'в работе' : 'не начат'})`);

  // Открытые критерии приёмки этого этапа из EXT_ROADMAP.md
  const sec = roadmap.split(/^## /m).find((s) => s.startsWith(`Этап ${current.n} —`));
  if (sec) {
    const open = [...sec.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]);
    const done = [...sec.matchAll(/^- \[x\] (.+)$/gm)].length;
    out.push(`Критерии приёмки: закрыто ${done}, открыто ${open.length}`);
    for (const c of open) out.push(`   [ ] ${c.length > 150 ? c.slice(0, 150) + '…' : c}`);
  }

  const uat = `docs/uat/ext-${current.n}.md`;
  if (existsSync(uat)) {
    out.push('');
    out.push(`Чек-лист для человека уже написан: ${uat} — этап ждёт ПРОВЕРКИ, а не доработки.`);
    out.push('Если человек не подтвердил результат — не трогать код, спросить итог проверки.');
  }
}

out.push('');
out.push('Правила вехи: Turnstile не обходим; к сайту — ни одного запроса сверх штатной работы бота;');
out.push('тег ext-N-done ставится ТОЛЬКО после живой проверки человеком. Полные критерии — docs/EXT_ROADMAP.md.');
console.log(out.join('\n'));
