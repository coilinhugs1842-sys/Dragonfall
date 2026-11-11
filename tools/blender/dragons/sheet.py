"""Contact sheet: python sheet.py out.png cols cellW img1 img2 ...  (system Python + Pillow)."""
import os
import sys

from PIL import Image, ImageDraw


def sheet(out, cols, cell_w, paths, labels=True):
    ims = [Image.open(p).convert('RGB') for p in paths]
    cell_h = int(cell_w * ims[0].height / ims[0].width)
    rows = (len(ims) + cols - 1) // cols
    sh = Image.new('RGB', (cols * cell_w, rows * cell_h), (30, 30, 30))
    for i, (im, p) in enumerate(zip(ims, paths)):
        im = im.resize((cell_w, cell_h), Image.LANCZOS)
        if labels:
            ImageDraw.Draw(im).text((6, 4), os.path.basename(p)[:-4], fill=(255, 255, 255))
        sh.paste(im, ((i % cols) * cell_w, (i // cols) * cell_h))
    sh.save(out)


if __name__ == '__main__':
    sheet(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:])
