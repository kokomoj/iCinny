// Default the bundled Cinny to matrix.org (any server can be chosen at sign-in)
// and drop the public-community clutter.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'web', 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

cfg.homeserverList = ['matrix.org'];
cfg.defaultHomeserver = 0;
cfg.allowCustomHomeservers = true;
cfg.featuredCommunities = { openAsDefault: false, spaces: [], rooms: [], servers: [] };
cfg.hashRouter = { enabled: false, basename: '/' };

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('config.json patched: default homeserver = matrix.org');
