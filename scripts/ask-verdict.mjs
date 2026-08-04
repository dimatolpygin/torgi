#!/usr/bin/env node
// Спрашивает итог проверки чек-листа и запускает /ext-done.
//
// Почему через node, а не через `set /p` в .bat: cmd.exe рвёт русский текст
// и теряет кавычки при передаче аргументов. Вердикт кладём в файл, команде
// передаём только ASCII — так ничего не ломается.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const CHECKLIST = 'docs/uat/CHECKLIST.md';
const VERDICT = '.claude/last-verdict.txt';

const pending = existsSync(CHECKLIST) ? (readFileSync(CHECKLIST, 'utf8').match(/^- \[ \] /gm) || []).length : 0;

console.log('');
console.log('  ══ Итог проверки ══');
if (pending) {
  console.log(`  В ${CHECKLIST} осталось неотмеченных пунктов: ${pending}.`);
} else {
  console.log(`  В ${CHECKLIST} неотмеченных пунктов нет.`);
}
console.log('  Напиши «ок», если всё сошлось, либо коротко — что именно не так.');
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('  Итог: ', (answer) => {
  rl.close();
  const verdict = (answer || '').trim() || 'ок';
  writeFileSync(VERDICT, verdict, 'utf8');
  console.log('');
  spawnSync('claude', ['/ext-done'], { stdio: 'inherit', shell: true });
});
