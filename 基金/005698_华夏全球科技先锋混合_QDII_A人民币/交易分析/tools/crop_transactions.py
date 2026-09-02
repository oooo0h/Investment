from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


SOURCE = Path(r"D:\WeChat_files\xwechat_files\wxid_fs5n306ex72922_70f8\temp\RWTemp\2026-09\9e20f478899dc29eb19741386f9343c8\a33d8e0c58b1a61851440346ba3a071b.jpg")
OUT_DIR = Path(__file__).resolve().parents[1] / "tmp" / "transaction_crops"
CHUNK_HEIGHT = 2600
OVERLAP = 160


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as image:
        image = image.convert("RGB")
        index = 1
        top = 0
        while top < image.height:
            bottom = min(top + CHUNK_HEIGHT, image.height)
            crop = image.crop((0, top, image.width, bottom))
            crop = ImageEnhance.Contrast(crop).enhance(1.25)
            crop = crop.filter(ImageFilter.SHARPEN)
            crop.save(OUT_DIR / f"part_{index:02d}_{top}_{bottom}.png")
            if bottom == image.height:
                break
            top = bottom - OVERLAP
            index += 1


if __name__ == "__main__":
    main()
