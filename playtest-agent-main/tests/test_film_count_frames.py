"""Count pictures use fake local evidence and never start a game or browser."""
from collections import Counter

import pytest
from PIL import Image


def test_hunt_rows():
    from tools.film_count_frames import HUNTS
    assert len(HUNTS) == 11
    assert Counter(row.kind for row in HUNTS) == {'Blind': 9, 'Hinted': 2}
    assert Counter(row.result for row in HUNTS) == {'Miss': 10, 'Found': 1}
    assert sum(row.false_reports for row in HUNTS) == 4
    assert [row.run for row in HUNTS] == [
        'sts2-blind-1', 'sts2-blind-2', 'sts2-room-a-1', 'sts2-room-a-2',
        'sts2-room-d-1', 'sts2-room-d-hint-1', 'sts2-room-f-1',
        'sts2-room-f-hint-1', 'sts2-room-g-1', 'sts2-room-g-2', 'sts2-room-g-3',
    ]


def test_picture_selection_and_outputs(tmp_path):
    from tools.film_count_frames import HUNTS, picture_for, write_frames
    for hunt in HUNTS:
        folder = tmp_path / 'data/runs' / hunt.run
        folder.mkdir(parents=True)
        for number, colour in [(1, 'red'), (29, 'green'), (60, 'blue')]:
            Image.new('RGB', (48, 32), colour).save(folder / f's{number:03}.jpg')
        Image.new('RGB', (48, 32), 'yellow').save(folder / 's9999.jpg')
    assert picture_for(tmp_path, HUNTS[0]).name == 's060.jpg'
    assert picture_for(tmp_path, HUNTS[-1]).name == 's029.jpg'
    paths = write_frames(tmp_path)
    assert [p.name for p in paths] == [f'count-{n:02}.jpg' for n in range(1, 12)]
    for index, path in enumerate(paths):
        assert path.parent == tmp_path / 'data/runs/sts2-film'
        with Image.open(path) as image:
            assert image.size == (1920, 640)
            assert image.format == 'JPEG'
            pixel = image.getpixel((500, 200))
            assert pixel[1 if index == 10 else 2] > 100
            assert pixel[2 if index == 10 else 1] < 20


@pytest.mark.parametrize('empty_folder', [False, True])
def test_missing_picture_names_run(tmp_path, empty_folder):
    from tools.film_count_frames import HUNTS, write_frames
    if empty_folder:
        (tmp_path / 'data/runs' / HUNTS[0].run).mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match='sts2-blind-1'):
        write_frames(tmp_path)


def test_hunt_11_requires_step_29(tmp_path):
    from tools.film_count_frames import HUNTS, picture_for
    folder = tmp_path / 'data/runs' / HUNTS[-1].run
    folder.mkdir(parents=True)
    Image.new('RGB', (48, 32), 'blue').save(folder / 's060.jpg')
    with pytest.raises(FileNotFoundError, match='sts2-room-g-3.*s029'):
        picture_for(tmp_path, HUNTS[-1])
