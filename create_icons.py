from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    # Crear imagen con fondo oscuro
    img = Image.new('RGB', (size, size), '#1a1a2e')
    draw = ImageDraw.Draw(img)

    # Dibujar círculo rojo
    margin = size // 6
    draw.ellipse([margin, margin, size-margin, size-margin], fill='#e94560')

    # Dibujar nota musical
    try:
        font_size = size // 3
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
    except:
        font = ImageFont.load_default()

    text = "♪"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    x = (size - text_width) // 2
    y = (size - text_height) // 2
    draw.text((x, y), text, fill='white', font=font)

    img.save(output_path, 'PNG')
    print(f"Creado: {output_path}")

# Crear iconos
create_icon(192, 'icons/icon-192.png')
create_icon(512, 'icons/icon-512.png')
print("Iconos generados!")
