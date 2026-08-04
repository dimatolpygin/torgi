#!/usr/bin/env node
// Автопрогон Вехи 3: гонит этапы подряд, БЕЗ остановки на человека.
// Каждый этап — отдельная сессия Claude Code (свежий контекст, ничего не гниёт).
//
// Останавливается сам в трёх случаях:
//   1. следующий этап помечен «Гейт: СТОП» — без человека физически невозможно;
//   2. этап не продвинулся (нет нового тега ext-N-auto) — значит затык, а не прогресс;
//   3. кончились этапы.
//
// Пункты, которые может подтвердить только человек, копятся в ОДИН файл
// docs/uat/CHECKLIST.md — его ты проходишь в конце, а не после каждого этапа.
//
// Запуск: node scripts/run-chain.mjs [--max N] [--dry]

import { readFileSync, existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 99;

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const git = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

function stages() {
  const status = read('docs/STATUS.md');
  const roadmap = read('docs/EXT_ROADMAP.md');
  const tags = git('git tag -l "ext-*"').split('\n').filter(Boolean);
  const out = [];
  for (const line of status.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(☐|🚧|✅|⏸)\s*\|\s*`(ext-(\d+)-done)`/);
    if (!m) continue;
    const n = Number(m[1]);
    const sec = roadmap.split(/^## /m).find((s) => s.startsWith(`Этап ${n} —`)) || '';
    const gate = sec.match(/\*\*Гейт:\s*(АВТО|СТОП)\*\*\s*—\s*([^.]+)/);
    out.push({
      n,
      title: m[2],
      gate: gate ? gate[1] : 'АВТО',
      why: gate ? gate[2].trim() : '',
      auto: tags.includes(`ext-${n}-auto`),
      done: tags.includes(`ext-${n}-done`),
    });
  }
  return out;
}

console.log('');
console.log('  ══ Автопрогон Вехи 3 ══');
console.log('  Этапы идут подряд без твоего участия. Проверка — одна, в конце.');
console.log('  Остановлюсь сам там, где без тебя нельзя: боевая ночь или ПК клиентки.');
console.log('  Права сессий ограничены файлом .claude/chain-settings.json (файлы, git, node).');
console.log('');

let ran = 0;
for (;;) {
  const list = stages();
  const next = list.find((s) => !s.auto && !s.done);

  if (!next) {
    console.log('  ✓ Все этапы, которые можно сделать машинно, пройдены.');
    break;
  }
  if (next.gate === 'СТОП') {
    console.log(`  ⏹ Дальше без тебя нельзя: этап ext-${next.n} — ${next.title}`);
    console.log(`     Причина: ${next.why}`);
    break;
  }
  if (ran >= MAX) {
    console.log(`  ⏸ Достигнут лимит --max ${MAX}. Следующий был бы ext-${next.n}.`);
    break;
  }

  console.log(`  ▶ Этап ext-${next.n} — ${next.title}`);
  if (dry) {
    console.log('     (--dry: сессия не запускается)');
    break;
  }

  const before = git('git tag -l "ext-*"');
  // Права передаём ФАЙЛОМ, а не флагом --allowedTools: строки вида «Bash(git *)»
  // при проходе через cmd.exe теряют кавычки, и правило превращается в «*)»,
  // которое Claude Code справедливо отбрасывает.
  const r = spawnSync(
    'claude',
    ['-p', '/ext-next', '--permission-mode', 'acceptEdits', '--settings', '.claude/chain-settings.json'],
    { stdio: 'inherit', shell: true },
  );
  ran++;

  if (r.status !== 0) {
    console.log(`  ⏹ Сессия этапа ext-${next.n} завершилась с ошибкой (код ${r.status}). Останавливаюсь.`);
    break;
  }
  if (git('git tag -l "ext-*"') === before) {
    console.log(`  ⏹ Затык: этап ext-${next.n} не поставил тег ext-${next.n}-auto — прогресса нет.`);
    console.log('     Смотри, что он написал выше, и запусти ext.bat вручную для разбора.');
    break;
  }
  console.log(`  ✓ ext-${next.n} прошёл автопроверки`);
  console.log('');
}

console.log('');
console.log('  ── Что дальше ──');
const cl = 'docs/uat/CHECKLIST.md';
if (existsSync(cl)) {
  const items = (read(cl).match(/^- \[ \] /gm) || []).length;
  console.log(`  Твоя проверка: ${cl} — ${items} пункт(ов).`);
  console.log('  Пройди их и запусти ok.bat.');
} else {
  console.log('  Чек-лист для тебя пока пуст — проверять нечего.');
}
console.log('');
