/**
 * Обход произвольного JSON-дерева.
 *
 * HTML-страницы музыкальных сервисов отдают огромные вложенные структуры,
 * форма которых меняется без предупреждения. Вместо жёстких путей мы обходим
 * дерево целиком и собираем узлы, подходящие под предикат, — так парсер
 * переживает мелкие изменения вёрстки.
 */

export function collectNodes(
  root: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
  limit = 2000,
): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];

  while (stack.length > 0 && found.length < limit) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      // Порядок важен: элементы плейлиста должны идти сверху вниз.
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }

    const record = node as Record<string, unknown>;
    if (predicate(record)) {
      found.push(record);
      continue;
    }

    const values = Object.values(record);
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }

  return found;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
