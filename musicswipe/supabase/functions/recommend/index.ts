import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { adminClient, AuthError, requireUser } from "../_shared/db.ts";
import { generateRecommendations } from "../_shared/engine.ts";

/**
 * POST /functions/v1/recommend  { "limit": 30 }
 *
 * Догружает ленту: клиент дёргает её, когда карточек в колоде остаётся мало.
 * Сами карточки читаются отдельно через RPC get_deck() — так клиент получает
 * их с учётом RLS и уже отсеянными свайпами.
 */
Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method !== "POST") {
    return errorResponse("Поддерживается только POST", 405, "method_not_allowed");
  }

  let userId: string;
  try {
    userId = (await requireUser(req)).id;
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.message, 401, "unauthorized");
    throw error;
  }

  let limit = 30;
  try {
    const body = await req.json().catch(() => ({}));
    const requested = Number(body?.limit);
    if (Number.isFinite(requested)) limit = Math.min(Math.max(requested, 5), 50);
  } catch {
    // тело необязательно — остаёмся на значении по умолчанию
  }

  try {
    const result = await generateRecommendations(adminClient(), userId, limit);

    if (result.inserted === 0 && result.reason === "no_seeds") {
      return errorResponse(
        "Сначала импортируйте плейлист — по нему собирается вкусовой профиль.",
        409,
        "no_taste_profile",
      );
    }

    return jsonResponse({ inserted: result.inserted, reason: result.reason ?? null });
  } catch (error) {
    console.error("recommend упал:", error);
    return errorResponse(
      `Не удалось обновить рекомендации: ${(error as Error).message}`,
      500,
      "recommend_failed",
    );
  }
});
