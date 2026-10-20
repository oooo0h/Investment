from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


SOURCE = Path(
    r"D:\WeChat_files\xwechat_files\wxid_fs5n306ex72922_70f8\temp\RWTemp\2026-09"
    r"\9e20f478899dc29eb19741386f9343c8\92d7b26ae609b1d4f35fd145289bc69f.jpg"
)
OUT_DIR = Path(__file__).resolve().parents[1] / "tmp" / "transaction_crops"
CHUNK_HEIGHT = 3200
OVERLAP = 220


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as image:
        image = image.convert("RGB")
        index = 1
        top = 0
        while top < image.height:
            bottom = min(top + CHUNK_HEIGHT, image.height)
            crop = image.crop((0, top, image.width, bottom))
            crop = ImageEnhance.Contrast(crop).enhance(1.2)
            crop = crop.filter(ImageFilter.SHARPEN)
            crop.save(OUT_DIR / f"part_{index:02d}_{top}_{bottom}.png")
            if bottom == image.height:
                break
            top = bottom - OVERLAP
            index += 1


if __name__ == "__main__":
    main()
