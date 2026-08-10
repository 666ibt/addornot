import type { SupabaseClient } from "./db.ts";
import { upsertCatalog } from "./catalog.ts";
import { recommend, type ProfileWeights, type SeedArtist } from "./recommender.ts";

/**
 * Пополнение ленты рекомендаций для пользователя.
 * Общий код для функций import-playlist и recommend.
 */
export async function generateRecommendations(
  admin: SupabaseClient,
  userId: string,
  limit = 30,
): Promise<{ inserted: number; reason?: string }> {
  const [{ data: profileRow }, { data: seedRows }, { data: knownRows }] = await Promise.all([
    admin
      .from("taste_profiles")
      .select("genre_weights, artist_weights, decade_weights, avg_bpm, avg_year")
      .eq("user_id", userId)
      .maybeSingle(),
    admin.rpc("seed_artist_ids", { p_user_id: userId, p_limit: 12 }),
    admin.rpc("known_provider_ids", { p_user_id: userId }),
  ]);

  const seeds: SeedArtist[] = (seedRows ?? []).map((row: Record<string, unknown>) => ({
    provider_id: String(row.provider_id),
    weight: Number(row.weight) || 1,
  }));

  if (seeds.length === 0) {
    return { inserted: 0, reason: "no_seeds" };
  }

  const profile: ProfileWeights = {
    genre_weights: (profileRow?.genre_weights ?? {}) as Record<string, number>,
    artist_weights: (profileRow?.artist_weights ?? {}) as Record<string, number>,
    decade_weights: (profileRow?.decade_weights ?? {}) as Record<string, number>,
    avg_bpm: profileRow?.avg_bpm != null ? Number(profileRow.avg_bpm) : null,
    avg_year: profileRow?.avg_year != null ? Number(profileRow.avg_year) : null,
  };

  const knownProviderIds = new Set<string>(
    (knownRows ?? []).map((row: Record<string, unknown>) => String(row.provider_id)),
  );

  const recommendations = await recommend({ profile, seeds, knownProviderIds, limit });
  if (recommendations.length === 0) {
    return { inserted: 0, reason: "no_candidates" };
  }

  const trackIds = await upsertCatalog(admin, recommendations.map((item) => item.track));

  const rows = recommendations
    .map((item) => {
      const trackId = trackIds.get(item.track.provider_id);
      if (!trackId) return null;
      return {
        user_id: userId,
        track_id: trackId,
        score: item.score,
        reason: item.reason,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    return { inserted: 0, reason: "catalog_write_failed" };
  }

  const { error } = await admin
    .from("recommendations")
    .upsert(rows, { onConflict: "user_id,track_id", ignoreDuplicates: true });

  if (error) {
    throw new Error(`Не удалось сохранить рекомендации: ${error.message}`);
  }

  return { inserted: rows.length };
}
