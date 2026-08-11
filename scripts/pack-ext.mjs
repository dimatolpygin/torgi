// Сборка папки расширения для отправки клиентке.
//
// Смысл: в `ext/` живёт и то, что нужно Chrome, и то, что нужно только разработчику —
// снятые страницы кабинета, предпросмотр панели, ночной скрипт с доступом к `.secrets`.
// Клиентке всё это отправлять незачем, а часть и нельзя. Поэтому список файлов берётся
// не «скопируем всю папку», а из самого манифеста: что он подключает, то и едет.
//
// Запуск: node scripts/pack-ext.mjs
import fs from 'node:fs';
import path from 'node:path';

const EXT = path.resolve('ext');
const OUT = path.resolve('dist', 'bron-komarovka');

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const files = new Set(['manifest.json']);

for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) files.add(js);
if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
if (manifest.action?.default_popup) files.add(manifest.action.default_popup);

// Панель тянет свои файлы сама, через <script src> и <link href> — вычитываем оттуда,
// иначе забытый файл обнаружится только у клиентки на экране.
const popup = fs.readFileSync(path.join(EXT, manifest.action.default_popup), 'utf8');
for (const m of popup.matchAll(/(?:src|href)="([^"]+)"/g)) files.add(m[1]);
// Фоновый скрипт подключает своё тем же способом.
const bg = fs.readFileSync(path.join(EXT, manifest.background.service_worker), 'utf8');
for (const m of bg.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const q of m[1].matchAll(/'([^']+)'/g)) files.add(q[1]);
}

fs.rmSync(OUT, { recursive: true, force: true });
let bytes = 0;
for (const rel of [...files].sort()) {
  const from = path.join(EXT, rel);
  if (!fs.existsSync(from)) throw new Error(`манифест ссылается на несуществующий файл: ${rel}`);
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  bytes += fs.statSync(from).size;
  console.log(`  ${rel}`);
}

// Проверка на дорожку: ничего лишнего в собранной папке быть не должно.
const stray = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (!files.has(path.relative(OUT, full).split(path.sep).join('/'))) stray.push(full);
  }
};
walk(OUT);
if (stray.length) throw new Error(`в собранной папке лишнее: ${stray.join(', ')}`);

console.log(`\nГотово: ${OUT}`);
console.log(`Файлов: ${files.size}, размер: ${Math.round(bytes / 1024)} КБ`);
