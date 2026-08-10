export const PLATFORMS = [
  { id: 'spotify', name: 'Spotify', icon: 'musical-notes' },
  { id: 'apple_music', name: 'Apple Music', icon: 'musical-note' },
  { id: 'youtube', name: 'YouTube Music', icon: 'logo-youtube' },
  { id: 'deezer', name: 'Deezer', icon: 'disc' },
  { id: 'yandex', name: 'Яндекс Музыка', icon: 'radio' },
  { id: 'soundcloud', name: 'SoundCloud', icon: 'pulse' },
] as const;

export type PlatformId = (typeof PLATFORMS)[number]['id'];

export function platformName(id: string | null | undefined): string {
  return PLATFORMS.find((platform) => platform.id === id)?.name ?? 'Плейлист';
}

/**
 * Определение платформы по ссылке — только для подсказки в интерфейсе.
 * Решение всё равно принимает сервер, который умеет разворачивать
 * короткие ссылки и разбирать формат адреса целиком.
 */
export function detectPlatform(url: string): PlatformId | null {
  const value = url.toLowerCase();

  if (value.includes('spotify.com') || value.startsWith('spotify:')) return 'spotify';
  if (value.includes('music.apple.com')) return 'apple_music';
  if (value.includes('youtube.com') || value.includes('youtu.be')) return 'youtube';
  if (value.includes('deezer.com') || value.includes('deezer.page.link')) return 'deezer';
  if (value.includes('music.yandex.')) return 'yandex';
  if (value.includes('soundcloud.com')) return 'soundcloud';

  return null;
}
