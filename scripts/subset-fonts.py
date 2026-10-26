"""Regenerate licensed local WOFF2 subsets from the prepared original TTFs."""
from pathlib import Path
import sys
from fontTools import subset

root = Path(__file__).resolve().parent.parent
source = Path(sys.argv[1])
chars = set(range(0x20, 0x100))
for first in range(0xA1, 0xFF):
    for second in range(0xA1, 0xFF):
        try:
            chars.update(ord(char) for char in bytes([first, second]).decode('euc_kr')
                         if 0xAC00 <= ord(char) <= 0xD7A3 or 0x3131 <= ord(char) <= 0x318E)
        except UnicodeDecodeError:
            pass
for folder in ['app', 'lib', 'seed', 'shared']:
    for path in (root / folder).rglob('*'):
        if path.suffix in ['.tsx', '.ts', '.json']:
            chars.update(map(ord, path.read_text()))
chars.update(map(ord, '너는 건강하게만 오렴, 좋은 것을 골라둘게.'))
for name, filename in [('GowunBatang-Bold', 'gb.ttf'),
                       ('SpoqaHanSansNeo-Regular', 'sp-Regular.ttf'),
                       ('SpoqaHanSansNeo-Bold', 'sp-Bold.ttf')]:
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    font = subset.load_font(str(source / filename), options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=chars)
    subsetter.subset(font)
    subset.save_font(font, str(root / 'public/fonts' / f'{name}.woff2'), options)
