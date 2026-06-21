// UAT этапа 16: парсинг кодовых слов + ролевая маршрутизация (логика) + тексты.
// Без сети и Telegram — чистые проверки.
process.env.TELEGRAM_CODE_WORDS = 'WordWife:wife:Жена, word-muzh:husband:Муж ,devword:dev:Разработчик,bad:nope:X';
const { config, ROLES } = await import('../config.js');
const { startReply, codeAcceptedReply, codeRejectedReply, preflightNotice, runResultText } = await import('../messages.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

console.log('1) Парсинг кодовых слов');
const cw = config.telegram.codeWords;
ok(cw.length === 3, `валидных слов 3 (битая роль отброшена), получено ${cw.length}`);
ok(cw.find(c => c.word === 'wordwife')?.role === 'wife', 'регистр слова приведён к нижнему, роль wife');
ok(cw.find(c => c.word === 'word-muzh')?.label === 'Муж', 'метка «Муж» распарсилась');
ok(!cw.find(c => c.role === 'nope'), 'невалидная роль nope отброшена');

console.log('2) Сопоставление введённого слова (как в bot.on(text))');
const match = (txt) => cw.find(c => c.word === txt.trim().toLowerCase());
ok(match('  WORDWIFE ')?.role === 'wife', 'ввод с пробелами/капсом → wife');
ok(!match('левое'), 'левое слово → нет совпадения');

console.log('3) Ролевая фильтрация рассылки (subscribers(roles))');
const map = new Map([['1','wife'],['2','husband'],['3','dev'],['4','dev']]);
const subs = (roles) => [...map].filter(([,r]) => !roles || roles.includes(r)).map(([id])=>id);
ok(subs(null).length === 4, 'null роли → все 4 (итог брони/алерт)');
ok(subs(['dev']).join(',') === '3,4', 'dev → только 3,4 (состояние сервера)');
ok(!subs(['dev']).includes('1') && !subs(['dev']).includes('2'), 'жена/муж НЕ получают dev-сообщения');

console.log('4) Тексты');
ok(startReply().includes('кодовое слово'), '/start просит кодовое слово');
ok(codeAcceptedReply('Жена').includes('Жена'), 'подтверждение содержит метку');
ok(codeRejectedReply().includes('не распознано'), 'отказ при неверном слове');
ok(preflightNotice({nextRun:'вторник 23.06 00:00', ready:2, total:2, dryRun:false}).includes('готов к подаче'), 'pre-flight текст');
ok(ROLES.join(',') === 'wife,husband,dev', 'ROLES = wife,husband,dev');

console.log(`\nИтог: ${pass} ✅ / ${fail} ❌`);
process.exit(fail ? 1 : 0);
