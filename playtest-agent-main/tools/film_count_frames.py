"""Build count pictures from the saved picture of each hunt."""
import argparse
from dataclasses import dataclass
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class Hunt:
    run: str
    kind: str
    result: str
    false_reports: int


HUNTS = (
    Hunt('sts2-blind-1', 'Blind', 'Miss', 2),
    Hunt('sts2-blind-2', 'Blind', 'Miss', 0),
    Hunt('sts2-room-a-1', 'Blind', 'Miss', 1),
    Hunt('sts2-room-a-2', 'Blind', 'Miss', 0),
    Hunt('sts2-room-d-1', 'Blind', 'Miss', 0),
    Hunt('sts2-room-d-hint-1', 'Hinted', 'Miss', 0),
    Hunt('sts2-room-f-1', 'Blind', 'Miss', 0),
    Hunt('sts2-room-f-hint-1', 'Hinted', 'Miss', 1),
    Hunt('sts2-room-g-1', 'Blind', 'Miss', 0),
    Hunt('sts2-room-g-2', 'Blind', 'Miss', 0),
    Hunt('sts2-room-g-3', 'Blind', 'Found', 0),
)


def picture_for(root, hunt):
    folder = Path(root) / 'data/runs' / hunt.run
    if hunt == HUNTS[-1]:
        picture = folder / 's029.jpg'
        if not picture.is_file():
            raise FileNotFoundError(f'{hunt.run}: missing picture s029.jpg')
        return picture
    pictures = [p for p in folder.glob('s*.jpg')
                if p.is_file() and re.fullmatch(r's[0-9]{3}\.jpg', p.name)]
    if not pictures:
        raise FileNotFoundError(f'{hunt.run}: missing saved picture in {folder}')
    return max(pictures, key=lambda p: int(p.stem[1:]))


def font(size, bold=False):
    name = 'arialbd.ttf' if bold else 'arial.ttf'
    try:
        return ImageFont.truetype(str(Path('C:/Windows/Fonts') / name), size)
    except OSError:
        return ImageFont.load_default(size=size)


def wrapped(draw, text, x, y, width, face, fill):
    line = ''
    height = face.size + 9
    for word in text.split():
        candidate = f'{line} {word}'.strip()
        if line and draw.textlength(candidate, font=face) > width:
            draw.text((x, y), line, font=face, fill=fill)
            y += height
            line = word
        else:
            line = candidate
    if line:
        draw.text((x, y), line, font=face, fill=fill)
        y += height
    return y


def count_frame(picture, index):
    hunt = HUNTS[index]
    frame = Image.new('RGB', (1920, 640), '#111820')
    with Image.open(picture) as source:
        frame.paste(source.convert('RGB').resize((1138, 640), Image.Resampling.LANCZOS), (0, 0))
    strip = Image.new('RGBA', frame.size)
    ImageDraw.Draw(strip).rectangle((0, 520, 1919, 639), fill=(0, 0, 0, 178))
    frame = Image.alpha_composite(frame.convert('RGBA'), strip).convert('RGB')
    draw = ImageDraw.Draw(frame)
    for tile, row in enumerate(HUNTS):
        x = 20 + tile * 172
        current, shown = tile == index, tile <= index
        colour = '#f5c542' if current else '#62452d' if row.kind == 'Hinted' else '#1d344c'
        draw.rectangle((x, 528, x + 159, 631), fill=colour if shown else '#182028')
        ink = '#111820' if current else '#ffffff' if shown else '#65707a'
        draw.text((x + 8, 530), str(tile + 1), font=font(26, True), fill=ink)
        if shown:
            draw.text((x + 8, 563), f'{row.kind} {row.result}', font=font(23), fill=ink)
            if row.false_reports:
                draw.text((x + 8, 596), f'{row.false_reports} false', font=font(23), fill=ink)
    x, y = 1170, 20
    draw.text((x, y), f'Hunt {index + 1} of 11', font=font(60, True), fill='white')
    y += 80
    draw.text((x, y), f'{hunt.kind}. {hunt.result}.', font=font(52), fill='white')
    y += 76
    if hunt.false_reports:
        suffix = 'report' if hunt.false_reports == 1 else 'reports'
        draw.text((x, y), f'{hunt.false_reports} false {suffix}', font=font(44), fill='#f5c542')
        y += 68
    if index >= 8:
        y = wrapped(draw, 'Room and seed chosen after 8 misses', x, y, 720, font(36), 'white')
    if index == 10:
        draw.text((x, y + 12), 'Step 29 of 60', font=font(36), fill='white')
    return frame


def write_frames(root):
    root = Path(root)
    pictures = [picture_for(root, hunt) for hunt in HUNTS]
    output = root / 'data/runs/sts2-film'
    output.mkdir(parents=True, exist_ok=True)
    paths = []
    for index, picture in enumerate(pictures):
        path = output / f'count-{index + 1:02}.jpg'
        count_frame(picture, index).save(path, quality=90)
        paths.append(path)
    return paths


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args(argv)
    for path in write_frames(args.root):
        print(path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
