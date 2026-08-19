'use strict';

/**
 * Claude vision fallback.
 *
 * When local OCR + regex parsing is not confident, we send the page image to
 * Claude and ask for the накладная / договор directly. This mirrors how the
 * original skill reads messy scans (stamps, handwriting, skew) far better than
 * plain OCR.
 *
 * Requires an Anthropic API key, configured in the app's Settings. The key is
 * stored locally (electron-store) and never committed.
 */

const DEFAULT_MODEL = 'claude-opus-4-8';
const API_URL = 'https://api.anthropic.com/v1/messages';

// Give up on a single page rather than let a stalled request hold an OCR worker
// (and therefore the whole batch) hostage. The page simply keeps its local OCR
// result and is flagged for review, exactly as any other AI failure.
const REQUEST_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `Ты — ассистент по разбору отсканированных топливных накладных (ТТН / ГСМ).
На изображении одна страница накладной. Это либо российская
"Товарно-транспортная накладная" (типовая форма № 1-т), либо накладная
Ферганского НПЗ "Накладная на отпуск материалов".

Найди на странице:
1. НОМЕР НАКЛАДНОЙ (накладная) — число рядом со словом «Накладная №».
   Иногда после числа стоит буква «ч» или «тч» (напр. «1125 тч», «1431 ч») —
   это часть номера, добавь её к числу без пробела: "1125тч", "1431ч".
2. НОМЕР ДОГОВОРА (договор) — бери его из строки «Контракт: Договор №…».
   Возможные виды:
   • "SGN", например SGN-158/25, SGN-59/26-P, SGN-2-25;
   • "ST-…" или "AZT-…", например ST-539/25-K, AZT-2/26;
   • "…/…-TASCO", например 73/26-TASCO, 116/26-TASCO;
   • "…/…-АЗС" или "…/…-АЗС-С", например 8/26-АЗС, 15/26-АЗС-С
     (кириллица «АЗС»; суффикс «-С» — только если он реально есть);
   • внутреннее перемещение → договор = "Перемещение".
   ВАЖНО: строку «Основание: Согласно договору №…-ПР» игнорируй — это
   другой (рамочный) договор, он не нужен.

Верни СТРОГО JSON без пояснений и без markdown:
{"nakladnaya": "<номер или пусто>", "dogovor": "<SGN-… | …-TASCO | …-АЗС[-С] | Перемещение | пусто>"}`;

/**
 * @param {Buffer} imageBuffer  PNG image of the page
 * @param {{apiKey: string, model?: string}} opts
 * @returns {Promise<{nakladnaya: string, dogovor: string, source: 'ai'}>}
 */
async function extractWithClaude(imageBuffer, opts) {
  if (!opts || !opts.apiKey) {
    throw new Error('Anthropic API key is not configured.');
  }
  const model = opts.model || DEFAULT_MODEL;
  const base64 = imageBuffer.toString('base64');

  const body = {
    model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          { type: 'text', text: 'Извлеки накладную и договор. Ответ строго в JSON.' },
        ],
      },
    ],
  };

  // The timer covers the whole exchange — headers AND body — so a connection
  // that opens and then stalls mid-response is cut off too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Claude API error ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = parseJsonLoose(text);
    return {
      nakladnaya: (parsed.nakladnaya || '').toString().trim(),
      dogovor: (parsed.dogovor || '').toString().trim(),
      source: 'ai',
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Claude API не ответил за ${Math.round(REQUEST_TIMEOUT_MS / 1000)} с — оставлено локальное распознавание.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the first JSON object from a possibly-chatty response. */
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        /* fall through */
      }
    }
    return {};
  }
}

module.exports = { extractWithClaude, DEFAULT_MODEL };
