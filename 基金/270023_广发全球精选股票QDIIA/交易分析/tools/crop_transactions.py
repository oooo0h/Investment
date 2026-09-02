from pathlib import Path
from PIL import Image


SOURCES = {
    "part1": Path(r"D:\WeChat_files\xwechat_files\wxid_fs5n306ex72922_70f8\temp\RWTemp\2026-09\9e20f478899dc29eb19741386f9343c8\c3d4fe3ab7460d57eafab36a07452a3d.jpg"),
    "part2": Path(r"D:\WeChat_files\xwechat_files\wxid_fs5n306ex72922_70f8\temp\RWTemp\2026-09\9e20f478899dc29eb19741386f9343c8\c76a41340816f8535320e6f9d99979cb.jpg"),
}
OUTPUT_DIR = Path(r"D:\wd\数据分析\基金\270023_广发全球精选股票QDIIA\交易分析\tmp\transaction_crops")
CROP_HEIGHT = 2600
OVERLAP = 260


OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
for label, source in SOURCES.items():
    with Image.open(source) as image:
        step = CROP_HEIGHT - OVERLAP
        index = 1
        top = 0
        while top < image.height:
            bottom = min(top + CROP_HEIGHT, image.height)
            crop = image.crop((0, top, image.width, bottom))
            crop.save(OUTPUT_DIR / f"{label}_{index:02d}_{top:05d}-{bottom:05d}.png")
            if bottom == image.height:
                break
            top += step
            index += 1
        print(f"{label}: {image.width}x{image.height}, crops={index}")
