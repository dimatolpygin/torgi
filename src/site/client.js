import { Client } from 'undici';
import { config } from '../config.js';

// HTTP-клиент к сайту с keep-alive соединением и простым cookie-jar.
// Keep-alive важен для скорости: в боевом режиме соединение и TLS готовятся заранее,
// а в 00:00 запрос уходит без задержки на установку связи.
export class SiteClient {
  constructor(baseUrl = config.site.baseUrl) {
    this.origin = new URL(baseUrl).origin;
    this.client = new Client(this.origin, {
      keepAliveTimeout: 600_000,
      keepAliveMaxTimeout: 600_000,
    });
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(headers) {
    const sc = headers['set-cookie'];
    if (!sc) return;
    const arr = Array.isArray(sc) ? sc : [sc];
    for (const line of arr) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) this.cookies.set(k, v);
    }
  }

  async request(method, path, { body, headers = {}, followRedirect = false } = {}) {
    const h = {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    };
    const cookie = this.cookieHeader();
    if (cookie) h['cookie'] = cookie;

    const res = await this.client.request({ method, path, headers: h, body });
    this.storeCookies(res.headers);
    const text = await res.body.text();

    const location = res.headers['location'];
    if (followRedirect && location && res.statusCode >= 300 && res.statusCode < 400) {
      const nextPath = location.startsWith('http') ? new URL(location).pathname : location;
      return this.request('GET', nextPath, { followRedirect });
    }
    return { status: res.statusCode, headers: res.headers, text, location };
  }

  get(path, opts) {
    return this.request('GET', path, opts);
  }

  // POST формы (application/x-www-form-urlencoded)
  post(path, formObj, opts = {}) {
    const body = new URLSearchParams(formObj).toString();
    return this.request('POST', path, {
      ...opts,
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
    });
  }

  async close() {
    await this.client.close();
  }
}

export default SiteClient;
