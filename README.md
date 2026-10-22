# iCinny

A macOS app for [Matrix](https://matrix.org) chat: the [Cinny](https://github.com/cinnyapp/cinny) web client in an Electron (Chromium) shell, with a Dock unread badge, rich notifications, real file downloads, and signed automatic updates.

## Install

1. Download **[iCinny-mac-arm64.zip](https://github.com/kokomoj/iCinny/releases/latest/download/iCinny-mac-arm64.zip)** (Apple Silicon Macs).
2. Unzip it and drag **iCinny.app** into **Applications**.
3. Open it and sign in. The sign-in screen defaults to `matrix.org`; type your own homeserver there if your account lives elsewhere.

The app is signed with a Developer ID and notarized by Apple. It checks for updates shortly after launch and every 4 hours, and installs them when you choose **Restart Now** (or the next time you quit). You can also use **iCinny → Check for Updates…**.

## Profiles

iCinny can run several copies side by side, each signed into a different account or homeserver and told apart by its Dock icon colour. Use the **Profiles** menu to:

- **New Profile…** — pick a name, an icon colour, and whether it opens automatically when iCinny starts. It launches as its own window right away.
- Switch to another profile — click its name in the menu; it opens (or comes to the front) as a separate copy.
- **Edit This Profile…** — rename it or change its colour (the Dock icon updates immediately).
- **Delete Profile…** — remove a profile and sign that account out on this Mac.

The original "iCinny" is the default profile and keeps its existing login. Named profiles store their data separately. Updates are handled by the default profile and apply to all of them together.

## How updates are protected

Each release publishes a `latest.json` feed. An update is only installed if:
- its SHA-256 matches the feed,
- the feed carries a valid Ed25519 signature from the release key (the public key ships inside the app), and
- the downloaded app passes a strict code-signature check and is signed by the same Apple Developer team.

## Building

`scripts/release.sh` builds the Cinny web client at its latest stable tag, applies the shell patches in `scripts/`, packages with electron-builder, signs and notarizes, and publishes a GitHub release. Signing keys and Apple credentials are not in this repository.

## License

Cinny is licensed under the GNU AGPL-3.0, and so is this shell; see [LICENSE](LICENSE). The source for every published build is this repository plus the Cinny release tag named in the release notes.
