// Разгон однотипных «чувствительных» запросов во времени.
//
// Зачем: сайт банит IP на час, если с него приходит пачка входов подряд — два POST
// /login/ в одну секунду с одного адреса выглядят как перебор пароля. Воспроизведено
// вживую 31.07.2026: та же подготовка на восстановленной сессии проходит чисто, а с
// полным входом обоих кабинетов мгновенно даёт ECONNREFUSED на час.
//
// Пейсер сериализует задачи и держит между ними минимальный интервал. Часы и сон
// внедряются, чтобы это можно было проверить тестом без сети и без ожидания.
export function createPacer({ gapMs, now = () => Date.now(), sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let lastAt = -Infinity;
  let chain = Promise.resolve();

  const runSpaced = async (fn) => {
    const wait = Math.max(0, lastAt + gapMs - now());
    if (wait > 0) await sleepFn(wait);
    lastAt = now();
    return fn();
  };

  // Каждый вызов встаёт в общую очередь (в т.ч. после ошибки предыдущего) и получает
  // СВОЙ результат: chain переприсваивается, а вызывающему возвращается его звено.
  return function paced(fn) {
    const next = chain.then(
      () => runSpaced(fn),
      () => runSpaced(fn),
    );
    chain = next.catch(() => {});
    return next;
  };
}

export default createPacer;
