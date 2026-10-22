'use strict';
// A thin header bar in the profile's colour, so side-by-side copies are easy to
// tell apart. The native title bar is hidden (traffic lights stay); this bar
// takes its place as the window's drag area and shows the profile name.
// The colour is muted: a light tint on light themes, a deep tint on dark ones.

const BAR_HEIGHT = 28;

// Strong colour per profile colour (matches the Dock icons in build/profile-icons).
const COLOR_HEX = {
  blue: '#1F6FF0',
  red: '#E0303C',
  green: '#1FA85A',
  purple: '#7A3AD8',
  orange: '#F07A1F',
  graphite: '#5A6372',
};

function hexFor(color) {
  return COLOR_HEX[color] || COLOR_HEX.blue;
}

// Returns JS (run in the page) that creates or updates the bar.
function barScript(color, label) {
  const cfg = JSON.stringify({ hex: hexFor(color), label: String(label || ''), h: BAR_HEIGHT });
  return `(() => {
    const cfg = ${cfg};
    const parse = (c) => { const m = String(c).match(/[\\d.]+/g); return m ? m.slice(0, 3).map(Number) : [26, 26, 26]; };
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
    const rgb = (a) => 'rgb(' + a.join(',') + ')';
    // The colour Cinny actually paints just under the bar (themes set it on an
    // inner element, not on body), found by walking up from that point.
    function pageBg() {
      const opaque = (c) => c && c !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(c);
      let el = document.elementFromPoint(8, cfg.h + 8);
      while (el && el !== document.documentElement) {
        if (el.id !== 'icinny-profile-bar') {
          const c = getComputedStyle(el).backgroundColor;
          if (opaque(c)) return parse(c);
        }
        el = el.parentElement;
      }
      const c = getComputedStyle(document.body).backgroundColor;
      if (opaque(c)) return parse(c);
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? [26, 26, 26] : [255, 255, 255];
    }
    function paint() {
      const bar = document.getElementById('icinny-profile-bar');
      if (!bar) return;
      const bg = pageBg();
      const dark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128;
      const c = hex(cfg.hex);
      bar.style.background = rgb(mix(bg, c, dark ? 0.32 : 0.2));
      bar.style.borderBottom = '1px solid ' + rgb(mix(bg, c, dark ? 0.55 : 0.4));
      bar.style.color = dark ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.75)';
    }
    let bar = document.getElementById('icinny-profile-bar');
    if (!bar) {
      const st = document.createElement('style');
      st.id = 'icinny-profile-bar-style';
      st.textContent =
        '#icinny-profile-bar{position:fixed;top:0;left:0;right:0;height:' + cfg.h + 'px;z-index:2147483647;' +
        '-webkit-app-region:drag;-webkit-user-select:none;user-select:none;display:flex;align-items:center;' +
        'justify-content:center;font:600 12px/1 -apple-system,system-ui,sans-serif;letter-spacing:.02em;box-sizing:border-box;' +
        'transition:background-color .3s ease}' +
        'html,body{height:100%}' +
        'body{box-sizing:border-box;padding-top:' + cfg.h + 'px !important}' +
        '#root{height:100% !important}';
      document.head.appendChild(st);
      bar = document.createElement('div');
      bar.id = 'icinny-profile-bar';
      document.body.appendChild(bar);
      // Follow Cinny theme changes (light/dark/system).
      const mo = new MutationObserver(() => requestAnimationFrame(paint));
      mo.observe(document.documentElement, { attributes: true, subtree: false });
      mo.observe(document.body, { attributes: true, subtree: false });
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
      setInterval(paint, 3000);
    }
    bar.textContent = cfg.label;
    paint();
  })();`;
}

module.exports = { BAR_HEIGHT, COLOR_HEX, hexFor, barScript };
