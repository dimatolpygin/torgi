// Инструмент боевой ночи (этап ext-5). Открывает по окну Chromium на каждый кабинет —
// с минским прокси и загруженным расширением — и дальше только СМОТРИТ.
//
// Что делает человек, а что машина. Разделение здесь не техническое, а принципиальное:
//   — проверку «я не робот» проходит ЧЕЛОВЕК своими руками в этом окне. Машина её не
//     трогает, не кликает и токен ниоткуда не добывает. На этом держится вся законность
//     схемы: браузер настоящий, сессия настоящая, человек присутствует.
//   — заявку в 00:00:00.000 отправляет расширение само, из этого же окна, той же кукой.
//     Этот скрипт не отправляет НИЧЕГО и ничего не нажимает.
//
// Куки кабинетов берутся из живых сессий бота (Redis на боевом сервере), поэтому входить
// логином-паролем не нужно: `POST /login/` — ровно та операция, за которую сайт банил IP
// на час (ночи 30 и 31.07.2026 потеряны целиком). Ноль входов — ноль этого риска.
//
// Запуск:  node ext/dev/night.mjs
//          node ext/dev/night.mjs --repetition   — репетиция: один опрос и выход. Проверяет
//          прокси, профили, загрузку расширения и связь с ним, ничего не подавая.
// Куки:    .secrets/night-cookies.json  →  [{ "label": "жена", "cookie": "..." }, ...]
//          (файл готовится командой из docs/uat/NIGHT-EXT.md, в git не попадает)

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EXT = path.resolve('ext');
const URL_REG = 'https://gorod.it-minsk.by/rinki/minsk/reg/fiz/';
const PROFILES = path.resolve('.secrets', 'night-profiles');

const proxy = Object.fromEntries(
  fs
    .readFileSync('.secrets/proxy-by.txt', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z]+=/.test(l))
    .map((l) => l.split('=').map((s) => s.trim())),
);

const cookies = JSON.parse(fs.readFileSync('.secrets/night-cookies.json', 'utf8'));
if (!Array.isArray(cookies) || !cookies.length) throw new Error('в .secrets/night-cookies.json нет ни одного кабинета');

// Время в логе — МИНСКОЕ: подача идёт по нему, и сверять график надо с ним. Местное
// время машины рядом в скобках, потому что оно может отличаться на часы (эта разработка
// ведётся из UTC+9, где минская полночь — 6 утра).
const ts = () => {
  const d = new Date();
  const minsk = d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Minsk' });
  const local = d.toLocaleTimeString('ru-RU');
  return minsk === local ? minsk : `${minsk} мск (у вас ${local})`;
};
const log = (label, msg) => console.log(`[${ts()}] ${label}: ${msg}`);

// Профили держим ПОСТОЯННЫМИ и разными: куки изолируются профилем, поэтому два кабинета
// в двух профилях не путаются (это же и есть схема ext-7). Постоянные — чтобы падение
// скрипта в 23:50 не стоило всей подготовки.
fs.mkdirSync(PROFILES, { recursive: true });

const windows = [];
for (const acc of cookies) {
  const dir = path.join(PROFILES, acc.label.replace(/[^a-zа-я0-9_-]+/gi, '_'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    proxy: { server: `http://${proxy.HOST}:${proxy.PORT}`, username: proxy.USER, password: proxy.PASS },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--window-size=1100,900`],
  });

  // Живая сессия бота вместо входа логином-паролем.
  await ctx.addCookies([
    { name: 'gorodid', value: acc.cookie, domain: 'gorod.it-minsk.by', path: '/', httpOnly: true, secure: true },
  ]);

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const page = ctx.pages()[0] || (await ctx.newPage());

  // Аудит: всё, что уходит на сайт с этой страницы, видно в консоли. В 00:00 здесь
  // должен появиться ровно один create_zajav на каждое место — и ни одного раньше.
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('gorod.it-minsk.by')) log(acc.label, `POST → ${r.url().replace('https://gorod.it-minsk.by', '')}`);
  });

  const res = await page.goto(URL_REG, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log(acc.label, `форма открыта, HTTP ${res.status()}`);
  windows.push({ label: acc.label, ctx, sw, page, reported: false });
}

// Content script просыпается не мгновенно после загрузки страницы, поэтому первый
// ответ иногда пустой — спрашиваем дважды. Молчание на второй раз уже значимо.
async function readState(w, tries = 2) {
  for (let i = 0; i < tries; i += 1) {
    const tabId = await w.sw.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'https://gorod.it-minsk.by/*' });
      return t ? t.id : null;
    });
    if (tabId != null) {
      const res = await w.sw.evaluate(
        (id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'GET_STATE' }, (x) => r(x || null))),
        tabId,
      );
      if (res && res.ok) return res.state;
    }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

function line(s) {
  if (!s) return 'страница не отвечает — не закрыта ли вкладка?';
  const left = Math.max(0, s.target.ms - Date.now());
  // Часы отдельно: за сутки до ночи «2166:17» читается как ошибка, а не как остаток.
  const hh = String(Math.floor(left / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((left % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  const cab = s.account && s.account.loggedIn ? s.account.cabinetId || 'вход есть' : 'КАБИНЕТ НЕ ВИДЕН';
  const tok = s.guard.hasToken ? `проверка пройдена (${s.guard.status.state})` : 'ПРОВЕРКА НЕ ПРОЙДЕНА';
  const armed = s.armedFor ? 'таймер взведён' : 'таймер не взведён';
  return `${hh}:${mm}:${ss} до подачи | ${cab} | ${tok} | ${armed}`;
}

const REPETITION = process.argv.includes('--repetition');

async function poll() {
  for (const w of windows) {
    const s = await readState(w).catch((e) => ({ err: String(e.message) }));
    if (s && s.err) {
      log(w.label, `не прочитал состояние: ${s.err}`);
      continue;
    }
    log(w.label, line(s));

    if (s && s.shot && !w.reported) {
      w.reported = true;
      console.log(`\n=== ИТОГ: ${w.label} ===`);
      console.log(`выстрел: ${s.shot.text}`);
      console.log(`итог:    ${s.outcome ? s.outcome.text : '—'}`);
      // Ответ сервера по каждой заявке целиком: ради него ночь и затевалась.
      for (const r of s.shot.results || []) console.log(`ответ ${r.i}: ${JSON.stringify(r.result || r)}`);
      console.log('=== проверьте личный кабинет: сколько мест реально закрепилось ===\n');
    }
  }
}

if (REPETITION) {
  await poll();
  console.log('\nРепетиция закончена: окна открывались, расширение отвечало, на сайт не ушло ни одной заявки.');
  for (const w of windows) await w.ctx.close();
  process.exit(0);
}

console.log('\nОкна открыты. Что нужно от человека:');
console.log('  1) убедиться, что ниже в каждой строке виден код кабинета (а не «КАБИНЕТ НЕ ВИДЕН»);');
console.log('  2) в 23:57 пройти в КАЖДОМ окне проверку «я не робот» и больше страницу НЕ обновлять;');
console.log('  3) ничего не нажимать до 00:00 — заявку расширение отправит само.\n');

setInterval(poll, 15000);
