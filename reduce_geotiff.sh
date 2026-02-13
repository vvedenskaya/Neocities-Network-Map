#!/bin/bash
# Уменьшает GeoTIFF с сохранением геопривязки.
# Требуется GDAL: brew install gdal

set -e
INPUT="odm/odm_orthophoto.tif"
OUTPUT="odm/odm_orthophoto_reduced.tif"

# Ищем gdal_translate: в PATH или в стандартных путях Homebrew
GDAL_TRANSLATE=""
if command -v gdal_translate &>/dev/null; then
  GDAL_TRANSLATE="gdal_translate"
elif [ -x /opt/homebrew/bin/gdal_translate ]; then
  GDAL_TRANSLATE="/opt/homebrew/bin/gdal_translate"
elif [ -x /usr/local/bin/gdal_translate ]; then
  GDAL_TRANSLATE="/usr/local/bin/gdal_translate"
fi

if [ ! -f "$INPUT" ]; then
  echo "❌ Файл не найден: $INPUT"
  exit 1
fi

if [ -z "$GDAL_TRANSLATE" ]; then
  echo "❌ gdal_translate не найден."
  echo ""
  echo "Установите GDAL (один раз, займёт несколько минут):"
  echo "   brew install gdal"
  echo ""
  echo "После установки запустите этот скрипт снова."
  exit 1
fi

echo "📥 Исходный файл: $INPUT ($(du -h "$INPUT" | cut -f1))"
echo "📤 Выходной файл: $OUTPUT (30% размера)"
echo "   Геопривязка сохраняется автоматически."
echo ""

$GDAL_TRANSLATE -of GTiff \
  -outsize 30% 30% \
  -co COMPRESS=JPEG \
  -co JPEG_QUALITY=85 \
  -co TILED=YES \
  "$INPUT" "$OUTPUT" || exit 1

echo ""
echo "✅ Готово: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "   Обновите страницу карты и выберите слой Drone Photo."
