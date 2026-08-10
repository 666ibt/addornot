#!/usr/bin/env bash
#
# Создаёт MusicSwipe/Core/Config/Supabase.plist из переменных окружения.
# Нужен для сборки в CI, где файла с ключами в репозитории нет.
#
#   SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=eyJ... ios/scripts/make-config.sh
#
# Если переменные не заданы, скрипт молча выходит: приложение соберётся
# и покажет экран с инструкцией вместо экрана входа.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${script_dir}/../MusicSwipe/Core/Config/Supabase.plist"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "SUPABASE_URL / SUPABASE_ANON_KEY не заданы — Supabase.plist не создан."
  exit 0
fi

cat > "$target" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>SUPABASE_URL</key>
	<string>${SUPABASE_URL}</string>
	<key>SUPABASE_ANON_KEY</key>
	<string>${SUPABASE_ANON_KEY}</string>
</dict>
</plist>
PLIST

echo "Создан ${target}"
