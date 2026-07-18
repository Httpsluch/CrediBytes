Convert SVGs to PNGs before loading in Chrome.

Option A (Python):  pip install cairosvg
  cairosvg icon16.svg  -o icon16.png
  cairosvg icon48.svg  -o icon48.png
  cairosvg icon128.svg -o icon128.png

Option B (Node):  npm install -g svgexport
  svgexport icon16.svg  icon16.png 16:16
  svgexport icon48.svg  icon48.png 48:48
  svgexport icon128.svg icon128.png 128:128

Chrome requires .png — do not load the .svg files directly.
