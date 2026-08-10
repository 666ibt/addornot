/**
 * Запуск фоновой работы в Edge Functions.
 *
 * Supabase даёт `EdgeRuntime.waitUntil()`, чтобы изолят не убили сразу после
 * отправки ответа. Локально (`supabase functions serve`) этого объекта может
 * не быть, поэтому есть запасной путь.
 */

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

export function runInBackground(task: Promise<unknown>): void {
  const guarded = task.catch((error) => {
    console.error("Фоновая задача упала:", error);
  });

  try {
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime?.waitUntil === "function") {
      EdgeRuntime.waitUntil(guarded);
      return;
    }
  } catch {
    // EdgeRuntime не объявлен — работаем без него
  }

  // Без waitUntil задача живёт, пока жив изолят: для локальной отладки хватает.
  void guarded;
}

/**
 * Вызов соседней Edge Function от имени сервиса.
 * Используется, чтобы продолжить разбор плейлиста следующей порцией:
 * каждая порция — отдельный вызов со своим лимитом времени.
 */
export async function invokeFunction(
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Не заданы SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Не удалось вызвать ${name}: ${response.status} ${text.slice(0, 200)}`);
  }

  // Тело ответа не нужно, но поток надо закрыть.
  await response.body?.cancel();
}

/** Проверяет, что запрос пришёл от сервиса, а не от пользователя. */
export function isServiceRequest(req: Request): boolean {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) return false;

  const header = req.headers.get("Authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "").trim() === key;
}
