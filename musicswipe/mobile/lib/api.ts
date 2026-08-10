import { supabase } from './supabase';
import type {
  ImportPlaylistResult,
  LikedTrack,
  PlaylistSummary,
  RebuildProfileResult,
  RecommendResult,
  SwipeDirection,
  TasteGenre,
  Track,
} from './types';

/**
 * Доступ к данным. Экраны не знают ни про имена RPC, ни про Edge Functions —
 * они работают с этими функциями.
 *
 * Вся выборка идёт через RPC: клиенту не нужно знать про join'ы и фильтры
 * по auth.uid(), за изоляцию отвечает RLS на сервере.
 */

const DECK_PAGE_SIZE = 20;

export async function fetchDeck(limit = DECK_PAGE_SIZE): Promise<Track[]> {
  const { data, error } = await supabase.rpc('get_deck', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as Track[];
}

export async function recordSwipe(
  trackId: string,
  direction: SwipeDirection,
  listenedMs: number,
): Promise<void> {
  const { error } = await supabase.rpc('record_swipe', {
    p_track_id: trackId,
    p_direction: direction,
    p_listened_ms: Math.max(0, Math.round(listenedMs)),
  });
  if (error) throw error;
}

export async function refillDeck(limit = 30): Promise<RecommendResult> {
  const { data, error } = await supabase.functions.invoke('recommend', {
    body: { limit },
  });
  if (error) throw error;
  return data as RecommendResult;
}

export async function importPlaylist(url: string): Promise<ImportPlaylistResult> {
  const { data, error } = await supabase.functions.invoke('import-playlist', {
    body: { url },
  });
  if (error) throw error;
  return data as ImportPlaylistResult;
}

export async function rebuildProfile(): Promise<RebuildProfileResult> {
  const { data, error } = await supabase.functions.invoke('rebuild-profile', {
    body: {},
  });
  if (error) throw error;
  return data as RebuildProfileResult;
}

export async function likedTracks(limit = 100, offset = 0): Promise<LikedTrack[]> {
  const { data, error } = await supabase.rpc('liked_tracks', {
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return (data ?? []) as LikedTrack[];
}

export async function tasteSummary(): Promise<TasteGenre[]> {
  const { data, error } = await supabase.rpc('taste_summary');
  if (error) throw error;
  return (data ?? []) as TasteGenre[];
}

export async function playlists(): Promise<PlaylistSummary[]> {
  const { data, error } = await supabase
    .from('playlists')
    .select(
      'id,platform,title,cover_url,owner_name,status,track_count,matched_count,error_message,created_at',
    )
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as PlaylistSummary[];
}
