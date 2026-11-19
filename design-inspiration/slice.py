# Usage: python design-inspiration/slice.py <slug>
# Cuts desktop.png into 1440x1800 strips and mobile.png into 390x2400 strips (kept readable when viewed), max 6 each.
import sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
slug = sys.argv[1]
d = f"design-inspiration/shots/{slug}"
for name, step in (("desktop", 1800), ("mobile", 2400)):
    im = Image.open(f"{d}/{name}.png")
    n = 0
    for y in range(0, im.height, step):
        if n >= 6: break
        n += 1
        im.crop((0, y, im.width, min(y + step, im.height))).save(f"{d}/{name}-{n}.png")
    print(slug, name, "strips:", n)
