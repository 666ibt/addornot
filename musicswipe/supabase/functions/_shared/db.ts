import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Клиент с service_role: обходит RLS, используется только внутри функций. */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Не заданы SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Достаёт пользователя из заголовка Authorization.
 * Ошибка здесь означает, что запрос пришёл без валидного access token.
 */
export async function requireUser(req: Request): Promise<{ id: string }> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new AuthError("Нужна авторизация");
  }

  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) {
    throw new AuthError("Недействительный токен доступа");
  }
  return { id: data.user.id };
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type { SupabaseClient };
