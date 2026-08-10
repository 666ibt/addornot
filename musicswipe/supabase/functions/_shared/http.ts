/**
 * Небольшие сетевые утилиты: троттлинг, ретраи, безопасный JSON.
 * Deezer держит лимит ~50 запросов / 5 секунд, поэтому все обращения к нему
 * идут через общий ограничитель частоты.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;
  private last = 0;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = 1000 / requestsPerSecond;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    // Хвост очереди не должен рваться из-за ошибки конкретной задачи.
    this.queue = scheduled.catch(() => {});
    return scheduled.then(task);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  browserLike?: boolean;
}

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const { timeoutMs = 15000, retries = 2, browserLike = false, ...init } = options;

  const headers = new Headers(init.headers ?? {});
  if (browserLike) {
    if (!headers.has("User-Agent")) headers.set("User-Agent", BROWSER_UA);
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9,ru;q=0.8");
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, headers, signal: controller.signal });
      clearTimeout(timer);

      // 429 и 5xx имеет смысл повторить.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 0;
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 400 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) {
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw lastError ?? new Error(`Не удалось выполнить запрос: ${url}`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `${url} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return await res.json() as T;
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, { browserLike: true, ...options });
  if (!res.ok) {
    throw new HttpError(res.status, `${url} -> ${res.status}`);
  }
  return await res.text();
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Вытаскивает содержимое <script ...id="..."...>JSON</script> из HTML-страницы. */
export function extractScriptJson<T>(html: string, scriptId: string): T | null {
  const pattern = new RegExp(
    `<script[^>]*id=["']${scriptId}["'][^>]*>([\\s\\S]*?)</script>`,
    "i",
  );
  const match = html.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as T;
  } catch {
    return null;
  }
}

/** Вытаскивает JSON-объект, идущий сразу после указанного префикса в HTML/JS. */
export function extractJsonAfter<T>(source: string, prefix: string): T | null {
  const start = source.indexOf(prefix);
  if (start < 0) return null;

  let i = source.indexOf("{", start + prefix.length);
  if (i < 0) return null;

  const begin = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(begin, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
