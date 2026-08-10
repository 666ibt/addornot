/**
 * Нормализация названий треков.
 *
 * Один и тот же трек на разных платформах пишется по-разному: «Numb (feat.
 * Jay-Z)», «Numb - Remastered 2019», «NUMB». Чтобы сравнивать такие записи
 * между собой, приводим их к общему виду — и делаем это в одном месте,
 * потому что ключ используют и матчер каталога, и отсев уже известных треков.
 */

/** Убирает приписки, которые не меняют сам трек. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[\(\[](feat\.?|ft\.?|with)[^\)\]]*[\)\]]/gi, "")
    .replace(
      /\s*[\(\[][^\)\]]*(remaster|remastered|deluxe|bonus|explicit|lyric|audio|video|official)[^\)\]]*[\)\]]/gi,
      "",
    )
    .replace(/\s*-\s*(remaster(ed)?|single version|album version)\b.*$/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Приводит строку к сравнимому виду: нижний регистр, только буквы и цифры. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Ключ трека для сравнения «этот же трек или нет».
 *
 * У исполнителя берём только первое имя: платформы по-разному перечисляют
 * соавторов («Artist», «Artist, Other», «Artist feat. Other»), и совпадение
 * по первому имени плюс названию надёжнее, чем по всему списку.
 */
export function trackKey(artist: string, title: string): string {
  const primaryArtist = artist.split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b/i)[0] ?? artist;
  return `${normalize(primaryArtist)}|${normalize(cleanTitle(title))}`;
}

/** Похожесть по токенам — коэффициент Жаккара. */
export function similarity(a: string, b: string): number {
  const setA = new Set(normalize(a).split(" ").filter(Boolean));
  const setB = new Set(normalize(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let common = 0;
  for (const token of setA) if (setB.has(token)) common++;
  return common / (setA.size + setB.size - common);
}
