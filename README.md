# iCinny

A macOS app for [Matrix](https://matrix.org) chat: the [Cinny](https://github.com/cinnyapp/cinny) web client in an Electron (Chromium) shell, with a Dock unread badge, rich notifications, real file downloads, and signed automatic updates.

## Install

1. Download **[iCinny-mac-arm64.zip](https://github.com/kokomoj/iCinny/releases/latest/download/iCinny-mac-arm64.zip)** (Apple Silicon Macs).
2. Unzip it and drag **iCinny.app** into **Applications**.
3. Open it and sign in. The sign-in screen defaults to `matrix.org`; type your own homeserver there if your account lives elsewhere.

The app is signed with a Developer ID and notarized by Apple. It checks for updates shortly after launch and every 4 hours, and installs them when you choose **Restart Now** (or the next time you quit). You can also use **iCinny → Check for Updates…**.

## How updates are protected

Each release publishes a `latest.json` feed. An update is only installed if:
- its SHA-256 matches the feed,
- the feed carries a valid Ed25519 signature from the release key (the public key ships inside the app), and
- the downloaded app passes a strict code-signature check and is signed by the same Apple Developer team.

## Building

`scripts/release.sh` builds the Cinny web client at its latest stable tag, applies the shell patches in `scripts/`, packages with electron-builder, signs and notarizes, and publishes a GitHub release. Signing keys and Apple credentials are not in this repository.

## License

Cinny is licensed under the GNU AGPL-3.0, and so is this shell; see [LICENSE](LICENSE). The source for every published build is this repository plus the Cinny release tag named in the release notes.
