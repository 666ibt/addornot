#!/usr/bin/env node
/**
 * Проверка настроек до запуска на телефоне.
 *
 * Показывает ровно то, что увидит приложение: не содержимое .env, а результат
 * разбора конфигурации самим Expo. Между этими двумя вещами и прячутся почти
 * все проблемы запуска.
 *
 *   npm run doctor
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

let problems = 0;

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function bad(message, hint) {
  problems++;
  console.log(`  ✗ ${message}`);
  if (hint) console.log(`    ${hint}`);
}

function mask(value) {
  if (!value) return '(пусто)';
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)} (длина ${value.length})`;
}

// --- 1. Файл .env ------------------------------------------------------------

console.log('\n1. Файл .env');

if (!existsSync(envPath)) {
  bad(
    `не найден: ${envPath}`,
    'Создайте его: cp .env.example .env — и подставьте свои значения.',
  );
} else {
  ok(`найден: ${envPath}`);

  const raw = readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));

  if (lines.length === 0) {
    bad('файл пуст');
  }

  for (const line of lines) {
    if (!line.includes('=')) {
      bad(`строка без «=»: ${line.slice(0, 40)}`);
      continue;
    }
    const [rawKey, ...rest] = line.split('=');
    const key = rawKey.trim();
    const value = rest.join('=').trim();

    if (rawKey !== key) {
      bad(`вокруг «=» в ${key} есть пробелы`, 'Пишите КЛЮЧ=значение без пробелов.');
    }
    if (/^["'].*["']$/.test(value)) {
      bad(`значение ${key} взято в кавычки`, 'Кавычки станут частью значения — уберите их.');
    }
    if (!key.startsWith('EXPO_PUBLIC_')) {
      bad(
        `${key} без префикса EXPO_PUBLIC_`,
        'Переменные без этого префикса в приложение не попадают.',
      );
    }
  }
}

// --- 2. Что из этого увидит приложение --------------------------------------

console.log('\n2. Конфигурация, как её собирает Expo');

let extra = {};
try {
  const output = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['expo', 'config', '--type', 'public', '--json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EXPO_NO_TELEMETRY: '1' } },
  );
  extra = JSON.parse(output).extra ?? {};
} catch (error) {
  bad('не удалось получить конфигурацию Expo', String(error.message).split('\n')[0]);
}

const url = extra.supabaseUrl ?? '';
const key = extra.supabaseAnonKey ?? '';

console.log(`    supabaseUrl:     ${url || '(пусто)'}`);
console.log(`    supabaseAnonKey: ${mask(key)}`);

if (!url) {
  bad('URL не подставился');
} else if (url.includes('ВАШ_')) {
  bad('в URL осталась заглушка из .env.example');
} else if (!url.startsWith('https://')) {
  bad(`URL должен начинаться с https:// — сейчас «${url}»`);
} else {
  ok('URL на месте');
}

if (!key) {
  bad('ключ не подставился');
} else if (key.includes('ВАШ_')) {
  bad('в ключе осталась заглушка из .env.example');
} else if (key.startsWith('sb_secret_') || key.includes('service_role')) {
  bad(
    'похоже, это service_role / secret ключ',
    'В приложение идёт только anon (или publishable) — service_role обходит все правила доступа.',
  );
} else {
  ok('ключ на месте');
}

// --- 3. Отвечает ли проект ---------------------------------------------------

if (url.startsWith('https://') && key && !url.includes('ВАШ_')) {
  console.log('\n3. Ответ проекта Supabase');
  try {
    const response = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key } });
    if (response.ok) {
      ok(`проект отвечает (HTTP ${response.status})`);
    } else if (response.status === 401) {
      bad('проект отвечает, но ключ не принят (401)', 'Скопирован не тот ключ или он обрезан.');
    } else {
      bad(`неожиданный ответ: HTTP ${response.status}`);
    }
  } catch (error) {
    bad('проект недоступен', `${error.cause?.message ?? error.message} — проверьте URL и интернет.`);
  }
}

// --- Итог --------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
if (problems === 0) {
  console.log('Всё в порядке. Запускайте: npx expo start\n');
} else {
  console.log(`Проблем: ${problems}. Исправьте их и запустите проверку снова.\n`);
}

process.exit(problems === 0 ? 0 : 1);
