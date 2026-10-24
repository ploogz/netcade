# Netcade

Plug-and-play online N64 and GameCube: lobbies, chat, controller mapping and one-click netplay.

Install Netcade, point it at your games, play. The emulators are **built into the installer**, so there is nothing else to download or configure. Under the hood, two mature open-source emulators run natively with full GPU access:

| System | Emulator | Online play |
|---|---|---|
| GameCube | Dolphin 2609a (built in) | Dolphin's own netplay (traversal + UPnP), auto-connected by Netcade |
| N64 | RetroArch 1.22.2 + Mupen64Plus-Next core (built in) | RetroArch netplay, started with one click; direct P2P or relay fallback |

Everyone on the same Netcade release has identical emulator builds, which is exactly what netplay needs.

A small lobby server (included) handles lobbies, chat, matchmaking and a relay for players behind strict routers.

> **Bring your own games.** Netcade never uploads, downloads or shares game files. Every player points Netcade at their own legally obtained copies, and the lobby checks that everyone has the exact same version before a match starts.

---

## Features

**Library**
- Scans your folders for `.z64 .n64 .v64` (N64) and `.iso .gcm .rvz .wia .ciso .gcz` (GameCube)
- Identifies games by content: N64 ROMs hash the same in any byte order; GameCube discs are identified by game ID + revision without decompressing
- Search, filters, favorites, recently played, play solo with one click

**Lobbies**
- 6-letter lobby codes, invite links (`netcade://join/CODE`), optional passwords, public lobby browser
- Automatic "do you have this game?" check with plain-English explanations ("you have Rev 0, lobby needs Rev 2")
- Ready checks, controller-port ordering, kick, host migration, live ping bars
- Emulator version mismatch warnings
- Chat, desktop notifications for joins, chat and match start
- Input delay: automatic from measured ping, or set manually

**Controls (also available inside every lobby)**
- Keyboard or controller profile per system
- Press-to-bind for keys, buttons and stick directions; conflict detection; live highlight as you press
- Written straight into Dolphin's `GCPadNew.ini` and RetroArch's config/remap files on each launch

**Networking**
- N64: host opens a port (UPnP); the server tests whether guests can reach it directly and otherwise routes through a WebSocket relay. Players in the same household are sent to the host's LAN address.
- GameCube: Dolphin's traversal server handles NAT. Netcade points Dolphin's session index at the lobby server, so the guest's Dolphin gets the host code automatically.
- Everyone uses the host's N64 renderer so games stay in sync.

**Quality of life**
- Graphics presets (Performance / Balanced / Quality), resolution scale, Vulkan / D3D12 / Metal, widescreen hack, fullscreen, V-Sync, FPS counter
- Async shader compilation for Dolphin (no stutter)
- Dolphin, RetroArch, the N64 core and 500+ controller profiles built in; optional switch to your own installs
- Netcade uses its own Dolphin user folder and a layered RetroArch config, so your normal emulator settings and saves are untouched
- Emulator shortcuts in N64 games need Right Ctrl held, so game keys never trigger them
- Run the lobby server inside the launcher ("Run server on this PC") for LAN parties
- Logs for every launch (Settings → Troubleshooting)

---

## For players

1. Install Netcade from this repo's Releases page:
   - **Windows:** `Netcade-x.y.z-win-x64.exe`
   - **macOS:** the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel)
   - **Linux:** the `.deb` (the `.AppImage` also works if your system has FUSE)
2. **Add game folder** in the Library.
3. Host a game from its card, share the code, and press **Start match** once everyone is ready.

That's it. Dolphin, RetroArch, the N64 core and controller profiles come inside the installer. If the release was built with your group's server address (see below), online play works immediately; otherwise paste the address once under **Settings → Online**, or choose **Run server on this PC** for a LAN party.

Players who prefer their own Dolphin/RetroArch installs can switch under **Settings → Emulators**, but everyone in a lobby then has to match versions by hand.

**What happens when the match starts**
- **N64:** RetroArch opens on every PC and connects by itself.
- **GameCube:** Dolphin opens with everything pre-filled. The host opens **Tools → Start NetPlay Session → Host** and double-clicks the game; guests open **Tools → Start NetPlay Session → Connect** and click Connect. The host then presses Start in Dolphin's NetPlay window. (Dolphin doesn't allow starting netplay from the command line, so these clicks can't be automated without modifying Dolphin.)

Everyone in a lobby must use the **same Dolphin or RetroArch version**. The lobby shows each player's version.

---

## Run your own server

The server is one small Node.js file with no database. Lobbies live in memory.

### Fly.io (simplest, ~free for small groups)
```bash
cd server
fly launch --copy-config --no-deploy   # edit the app name in fly.toml first
fly deploy
```
Your server address is `https://<app-name>.fly.dev`.

### Any VPS or home server with Docker
```bash
docker run -d --restart unless-stopped -p 8080:8080 -e TRUST_PROXY=0 ghcr.io/<your-github-user>/netcade-server:latest
```
(The image is published by the GitHub workflow when you push a version tag; or `docker build -t netcade-server server/`.)
Put it behind HTTPS (Caddy, nginx) for internet use, and set `TRUST_PROXY=1` when it's behind a reverse proxy.

### Plain Node
```bash
cd server && npm install && PORT=8080 node server.js
```

The relay carries N64 traffic only when direct connections fail, and is lightweight (controller inputs, not video).

---

## Building from GitHub

1. Create a GitHub repository and push this folder to it.
2. Every push runs the tests (`.github/workflows/build.yml`).
3. Optional but recommended: add a repository variable **`NETCADE_SERVER_URL`** (repo → Settings → Secrets and variables → Actions → Variables) with your server address, e.g. `https://my-netcade.fly.dev`. Installers built afterwards have it pre-filled, so players never type it.
4. To make installers, tag a version:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
   GitHub Actions downloads the pinned emulator builds for each OS (`launcher/emulators.json`), packs them into the Windows installer, macOS `.dmg` files (Intel and Apple Silicon) and Linux `.deb` / `.AppImage`, then attaches them to a **draft** release. Publish the draft when you're happy. The server Docker image is pushed to GitHub Packages at the same time.
5. Installed copies check that Releases page for updates automatically.

### What's inside the installer

`scripts/fetch-emulators.js` assembles `vendor/<os>-<arch>/` from official sources listed in `launcher/emulators.json`:

| Component | Windows | macOS | Linux |
|---|---|---|---|
| Dolphin 2609a | official `.7z` | official universal `.dmg` | community AppImage of the same release ([pkgforge-dev/Dolphin-emu-AppImage](https://github.com/pkgforge-dev/Dolphin-emu-AppImage)), since Dolphin publishes no standalone Linux build |
| RetroArch 1.22.2 | official stable `.7z` (menu artwork and shaders removed) | official `RetroArch_Metal.dmg` | official stable AppImage |
| Mupen64Plus-Next | libretro buildbot | libretro buildbot (per architecture) | libretro buildbot |
| Controller profiles | retroarch-joypad-autoconfig | same | same |
| VC++ runtime | installed silently if missing (Dolphin needs it) | — | — |

AppImages are unpacked at build time, so players don't need FUSE. The N64 core build is identified by hash and shown next to each player's RetroArch version in lobbies, so a mismatch is visible.

**Upgrading emulators:** edit the versions/URLs in `launcher/emulators.json` and tag a new release. Netplay requires everyone to be on the same Netcade release, so tell your group to update together.

**Building locally:** `cd launcher && npm run dist` fetches the emulators for your OS (cached between runs) and builds the installer. macOS bundles must be built on a Mac, Linux bundles on Linux.

### Developing locally
```bash
cd launcher
npm install
npm start          # runs the app
npm test           # unit tests

cd ../server
npm install
npm test           # lobby, Dolphin index and relay tests
```

### Code signing
Builds are unsigned by default, so Windows SmartScreen and macOS Gatekeeper will warn on first launch ("More info → Run anyway" / right-click → Open). To sign, add the certificate secrets that [electron-builder documents](https://www.electron.build/code-signing) remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the workflow, and replace the Mac `"identity": "-"` (ad-hoc signing, which Apple Silicon requires at minimum) with your Developer ID. On macOS 15+, unsigned apps are opened via System Settings → Privacy & Security → **Open Anyway**.

---

## Project layout

```
server/                 lobby server (Node + ws)
  server.js             lobbies, chat, Dolphin session index (/dolphin/v0/*), relay (/relay)
  test/                 integration tests
launcher/               Electron desktop app
  main.js               settings, library, lobby connection, emulator sessions
  preload.js            the only bridge between UI and system
  lib/romInfo.js        N64 / GameCube identification and matching
  lib/inputMaps.js      control mapping -> Dolphin and RetroArch formats
  lib/dolphin.js        Dolphin config + launch
  lib/retroarch.js      RetroArch config + launch
  lib/tunnel.js         TCP <-> WebSocket relay
  renderer/             UI (no framework)
  test/                 unit tests
.github/workflows/      CI and release builds
```

## Troubleshooting

- **"You don't have the exact game"**: the lobby needs the same region and revision. The message tells you which one; add that file to a game folder and click Rescan.
- **Desyncs in N64 games**: make sure everyone is on the same Netcade release (the lobby flags differing RetroArch/core versions); the host's renderer is used automatically.
- **Mac: N64 renderer**: macOS has no native Vulkan, so Netcade defaults Macs to the GLideN64 renderer. If a Mac player joins a lobby whose host uses ParaLLEl-RDP and N64 fails to start, ask the host to switch to GLideN64 in Settings → Graphics.
- **Windows asks for permission during install**: that's the Microsoft Visual C++ runtime Dolphin needs, installed only if your PC doesn't already have a recent one.
- **Guests can't connect to a GameCube host**: if the host code didn't arrive automatically, the host can paste it from Dolphin's NetPlay window into the lobby ("Send to guests"). Strict routers on both sides may need the host to enable UPnP or forward port 2626.
- **A controller button doesn't work in Dolphin**: open Dolphin → Controllers → Port 1 and adjust; Netcade rewrites Port 1 each launch from the Controls page, so make the permanent change in Netcade.
- **Logs**: Settings → Troubleshooting → Open logs (`netcade.log`, `dolphin-last.log`, `retroarch-last.log`).

## License

Netcade's own code is MIT licensed. The installers also contain unmodified copies of Dolphin (GPL-2.0-or-later), RetroArch (GPL-3.0-or-later) and Mupen64Plus-Next (GPL-2.0), which Netcade runs as separate programs. Each install includes `resources/vendor/LICENSES/THIRD_PARTY.md` with the exact versions and links to their complete source code.

If you distribute these installers publicly, the GPL requires that recipients can get the corresponding source. Linking upstream sources (as above) is the common practice; for strict compliance, also keep copies of the exact source archives for each release you publish.

No games, BIOS files or other copyrighted game data are included, and Netcade never transfers them between players. Nintendo 64 and GameCube are trademarks of Nintendo, which is not affiliated with this project.
