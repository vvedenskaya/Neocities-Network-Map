"""


Использование:
    python reduce_geotiff.py
"""

import sys
from pathlib import Path

try:
    import rasterio
    from rasterio.enums import Resampling
except ImportError:
    print("❌ Установите rasterio: pip install rasterio")
    sys.exit(1)

def reduce_geotiff(input_path, output_path, scale_factor=0.3):
    """
    Уменьшает GeoTIFF в scale_factor раз (0.3 = 30% от оригинала).
    Сохраняет всю геопривязку (координаты, проекцию).
    
    Args:
        input_path: путь к исходному GeoTIFF
        output_path: путь для сохранения уменьшенного файла
        scale_factor: коэффициент уменьшения (0.3 = уменьшить до 30%)
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    
    if not input_path.exists():
        print(f"❌ Файл не найден: {input_path}")
        return False
    
    print(f"📥 Загружаю: {input_path}")
    print(f"   Размер: {input_path.stat().st_size / 1024 / 1024:.1f} MB")
    
    with rasterio.open(input_path) as src:
        # Вычисляем новые размеры
        new_width = int(src.width * scale_factor)
        new_height = int(src.height * scale_factor)
        
        print(f"📐 Исходное разрешение: {src.width} x {src.height}")
        print(f"📐 Новое разрешение: {new_width} x {new_height}")
        
        # Новые параметры трансформации (геопривязка сохраняется!)
        transform = src.transform * src.transform.scale(
            (src.width / new_width),
            (src.height / new_height)
        )
        
        # Создаем профиль для выходного файла
        profile = src.profile.copy()
        profile.update({
            'width': new_width,
            'height': new_height,
            'transform': transform,
            'compress': 'jpeg',  # Сжатие для уменьшения размера
            'jpeg_quality': 85,
            'tiled': True,  # Тайлинг для лучшей производительности
            'blockxsize': 256,
            'blockysize': 256,
        })
        
        print(f"📤 Сохраняю: {output_path}")
        
        with rasterio.open(output_path, 'w', **profile) as dst:
            # Пересчитываем данные с ресемплингом
            for i in range(1, src.count + 1):
                data = src.read(
                    i, 
                    out_shape=(new_height, new_width), 
                    resampling=Resampling.bilinear  # Билинейная интерполяция для качества
                )
                dst.write(data, i)
        
        old_size = input_path.stat().st_size / 1024 / 1024
        new_size = output_path.stat().st_size / 1024 / 1024
        
        print(f"✅ Готово!")
        print(f"   Исходный: {old_size:.1f} MB")
        print(f"   Новый: {new_size:.1f} MB")
        print(f"   Уменьшение: {old_size / new_size:.1f}x")
        print(f"   Геопривязка сохранена ✓")
        return True

if __name__ == '__main__':
    input_file = 'odm/odm_orthophoto.tif'
    output_file = 'odm/odm_orthophoto_reduced.tif'
    
    # Коэффициент уменьшения: 0.3 = 30% от оригинала (примерно 50-60 MB)
    # Можно изменить: 0.5 = 50%, 0.2 = 20% (меньше размер, но ниже качество)
    scale = 0.3
    
    print("=" * 60)
    print("Уменьшение GeoTIFF с сохранением геопривязки")
    print("=" * 60)
    
    if reduce_geotiff(input_file, output_file, scale):
        print("\n💡 Теперь обновите map.js:")
        print(f"   const DRONE_GEOTIFF_URL = 'odm/odm_orthophoto_reduced.tif';")
    else:
        print("\n❌ Ошибка при обработке файла")
