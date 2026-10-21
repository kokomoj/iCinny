import os
BIRD_RING = "M9,0C4,0,0,4,0,9c0,5,4,9,9,9c5,0,9-4,9-9C18,4,14,0,9,0z"
BIRD = ("M1.2,10.8l3.5-2.3c0-0.1,0-0.2,0-0.3c0-1.8,1.3-3.2,3.1-3.4c0.1,0,0.2,0,0.4,0c1.2,0,2.3,0.6,2.9,1.6"
        "c0.3-0.1,0.6-0.1,0.9-0.1c0.4,0,0.8,0,1.2,0.1c0.7,0.2,1.4,0.5,2,0.9C14.6,7.1,14,7,13.3,7c-1.2,0-2.2,0.4-2.9,1.4"
        "c-0.7,0.9-1.1,2-1.1,3.2c0,1.5-0.4,2.9-1.3,4.2c-0.3,0.4-0.5,0.7-0.8,1C4.2,16.1,1.9,13.8,1.2,10.8z")
TILE = '<rect x="100" y="100" width="824" height="824" rx="185" ry="185"'
SHADOW = '<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/></filter>'

def wrap(defs, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>{SHADOW}{defs}</defs>{body}</svg>'

def emblem(cx, cy, size, disc, bird, eye=True):
    s = size/18
    return (f'<g transform="translate({cx-size/2},{cy-size/2}) scale({s})">'
            f'<path d="{BIRD_RING} {BIRD}" fill="{disc}" fill-rule="evenodd"/>'
            f'<clipPath id="c{cx}{size}"><circle cx="9" cy="9" r="9"/></clipPath>'
            f'<path d="{BIRD}" fill="{bird}"/>'
            + (f'<circle cx="9.5" cy="6.4" r="0.55" fill="{disc}"/>' if eye else '') + '</g>')

icons = {}
# A — Dusk: indigo->magenta, white disc, gradient bird
icons["A-dusk"] = wrap(
  '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B1E8F"/><stop offset=".55" stop-color="#7B2CBF"/><stop offset="1" stop-color="#E0447A"/></linearGradient>'
  '<radialGradient id="glow" cx=".5" cy=".42" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'
  '<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>',
  f'<g filter="url(#sh)">{TILE} fill="url(#g)"/></g>{TILE} fill="url(#hl)"/>'
  '<circle cx="512" cy="500" r="330" fill="url(#glow)"/>'
  + emblem(512, 512, 520, "#FFFFFF", "#5A24A8"))

# B — Bubble: coral tile, white chat bubble, bird inside
icons["B-bubble"] = wrap(
  '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A5B"/><stop offset="1" stop-color="#F0365A"/></linearGradient>'
  '<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'
  '<filter id="bs"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#7a0f2a" flood-opacity=".35"/></filter>',
  f'<g filter="url(#sh)">{TILE} fill="url(#g)"/></g>{TILE} fill="url(#hl)"/>'
  '<g filter="url(#bs)"><path d="M512 230c-170 0-300 112-300 262 0 82 40 155 104 203-6 44-30 86-66 112 72 6 140-20 186-62 24 6 50 9 76 9 170 0 300-112 300-262S682 230 512 230z" fill="#fff"/></g>'
  + emblem(512, 492, 400, "#F24E5C", "#FFFFFF"))

# C — Midnight: near-black tile, neon mint disc, Matrix brackets
icons["C-midnight"] = wrap(
  '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B2230"/><stop offset="1" stop-color="#0A0D14"/></linearGradient>'
  '<linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5CF2B4"/><stop offset="1" stop-color="#1FB6D9"/></linearGradient>'
  '<filter id="neon" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
  f'<g filter="url(#sh)">{TILE} fill="url(#g)"/></g>'
  f'{TILE} fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="3"/>'
  '<g stroke="url(#m)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".9">'
  '<path d="M300 270h-60v484h60"/><path d="M724 270h60v484h-60"/></g>'
  f'<g filter="url(#neon)">' + emblem(512, 512, 380, "url(#m)", "#0E131C") + '</g>')

# D — Daylight: soft sky tile, layered rings, deep-blue disc
icons["D-daylight"] = wrap(
  '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8F3FF"/><stop offset="1" stop-color="#B9D8FF"/></linearGradient>'
  '<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F6BFF"/><stop offset="1" stop-color="#1A2E8C"/></linearGradient>',
  f'<g filter="url(#sh)">{TILE} fill="url(#g)"/></g>'
  '<circle cx="512" cy="512" r="340" fill="#2F6BFF" opacity=".10"/>'
  '<circle cx="512" cy="512" r="290" fill="#2F6BFF" opacity=".14"/>'
  + emblem(512, 512, 460, "url(#d)", "#FFFFFF"))

for k, v in icons.items():
    open(f"{k}.svg", "w").write(v)

cells = "".join(f'<div class="c"><div class="row"><img src="{k}.svg" width="256"><img src="{k}.svg" width="64"><img src="{k}.svg" width="32"></div><p>{k}</p></div>' for k in icons)
open("sheet.html","w").write(f'''<html><body style="margin:0;background:linear-gradient(#2a2a2e,#1c1c1f);font:600 20px -apple-system;color:#ddd">
<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:20px;padding:30px">{cells}</div>
<div style="display:flex;gap:18px;justify-content:center;padding:18px;margin:0 160px 30px;background:rgba(255,255,255,.18);border-radius:26px">
{"".join(f'<img src="{k}.svg" width="96">' for k in icons)}</div>
<style>.c{{text-align:center}}.row{{display:flex;align-items:center;justify-content:center;gap:24px}}p{{margin:6px}}</style></body></html>''')

# B2 — Bubble Blue
bubble = '<path d="M512 230c-170 0-300 112-300 262 0 82 40 155 104 203-6 44-30 86-66 112 72 6 140-20 186-62 24 6 50 9 76 9 170 0 300-112 300-262S682 230 512 230z" fill="#fff"/>'
blue = wrap(
  '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4FA8FF"/><stop offset="1" stop-color="#1F4FE0"/></linearGradient>'
  '<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'
  '<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3D8BFF"/><stop offset="1" stop-color="#1F4FE0"/></linearGradient>'
  '<filter id="bs"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#0b1f6b" flood-opacity=".35"/></filter>',
  f'<g filter="url(#sh)">{TILE} fill="url(#g)"/></g>{TILE} fill="url(#hl)"/>'
  f'<g filter="url(#bs)">{bubble}</g>' + emblem(512, 492, 400, "url(#d)", "#FFFFFF"))
open("B2-bubble-blue.svg","w").write(blue)
