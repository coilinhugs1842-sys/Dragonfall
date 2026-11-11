"""Paint the atlases of one dragon class (system Python 3 with numpy + Pillow).

  python tools/blender/dragons/paint_dragon.py <class> [<class> ...]

Writes art-source/dragons/<class>/<class>_base.png (sRGB) and <class>_emissive.png (grey mask).
"""
import importlib
import os
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)

from dragonlib.paint import paint  # noqa: E402


def main():
    for cls in sys.argv[1:]:
        t0 = time.time()
        params = importlib.import_module('classes.' + cls).PARAMS
        out = os.path.join(REPO, 'art-source', 'dragons', cls)
        os.makedirs(out, exist_ok=True)
        base, emis, _ = paint(params)
        Image.fromarray(base, 'RGB').save(os.path.join(out, cls + '_base.png'), optimize=True)
        Image.fromarray(np.stack([emis] * 3, axis=-1), 'RGB').save(os.path.join(out, cls + '_emissive.png'), optimize=True)
        print('%s: %.1f s' % (cls, time.time() - t0))


if __name__ == '__main__':
    main()
