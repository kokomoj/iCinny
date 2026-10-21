// Build-time patch to Cinny's web source: report the unread count to the Electron shell.
// Cinny only swaps the favicon (unread / highlight). We add one call so the Dock badge
// can show a number. If the anchor ever moves upstream, we warn and keep going — the
// shell still shows a dot badge by watching the favicon (see preload.js).
const fs = require('fs');
const path = require('path');

const cinnyDir = process.argv[2] || path.join(__dirname, '..', '..', 'cinny-web');
const file = path.join(cinnyDir, 'src/app/pages/client/ClientNonUIFeatures.tsx');
const MARK = '/* cinny-electron:badge */';

let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) {
  console.log('badge patch: already applied');
  process.exit(0);
}

const anchor = `    if (notification) {
      setFavicon(highlight ? LogoHighlightSVG : LogoUnreadSVG);`;

if (!src.includes(anchor)) {
  console.warn('badge patch: ANCHOR NOT FOUND — skipping (dot-badge fallback only)');
  process.exit(0);
}

const inject = `    ${MARK}
    let badgeCount = 0;
    roomToUnread.forEach((unread) => {
      // leaf rooms only (space entries aggregate their children and carry a "from" set)
      if (unread.from === null) badgeCount += unread.total;
    });
    (window as any).cinnyShell?.setBadge?.(badgeCount, highlight);

`;

src = src.replace(anchor, inject + anchor);
fs.writeFileSync(file, src);
console.log('badge patch: applied');
