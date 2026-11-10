# Discord Renewed

A custom Discord desktop client built on **Electron**. It loads the real Discord
web app, then adds deep customisation, a Spotify mini-player, Rich Presence
support and a rebuilt screen-share flow. All of the customisation UI lives
inside Discord's own settings menu, so it looks and feels native.

> Personal project by **Bailey Montoya**. Not affiliated with or endorsed by Discord.

<!-- Screenshots: add images to docs/ and reference them here, e.g.
![Settings](docs/settings.png) -->

## Features

**Customisation**
- Custom image **and video** backgrounds with dimming. Video is streamed through a custom `dr-media://` protocol.
- **Customisation Mode**: restyle individual sections of Discord's UI, block by block.
- Settings tabs injected into Discord's native settings page, driven by a schema-based settings system.
- Every setting persists across restarts.

**Spotify integration**
- Now-playing widget with OAuth 2.0 **PKCE** sign-in (no client secret shipped).
- Playback controls (previous / play-pause / next) and seeking.
- A docked mini-player that the sidebar wraps around, with several display modes and smooth progress between API polls.
- Custom colours and a background image for the player.

**Desktop parity & native integration**
- A `DiscordNative` **desktop spoof** that bridges real native modules, so Discord renders its desktop UI (native title bar, window controls) inside a web shell.
- **Rich Presence**: a local `discord_rpc` IPC transport, so games and apps can show activity just as they do with the official client.
- A **webpack module patcher** that finds and patches Discord's internal modules at runtime from the main world.
- Screen sharing fixed for the web shell, with a picker rebuilt 1-to-1 with Discord's, working audio capture, a stream-quality unlock and an Advanced bitrate menu.
- System tray (minimise-to-tray), native notifications, taskbar mention badge & flash, auto-start on login (suppressing the official client's startup entry), and a native image right-click menu.

**Performance**
- Live RAM meter, cache purge, and two performance modes (Smooth / Optimised) for low-memory machines.

## Tech stack

- **Electron**: main process, preload scripts, IPC, custom protocols, tray, and notifications
- **JavaScript** (Node.js + browser), with no framework in the injected UI
- **Spotify Web API** (OAuth 2.0 PKCE)
- **Discord RPC protocol** (local IPC transport)

## Project structure

| File | Role |
| --- | --- |
| [`main.js`](discord-renewed/main.js) | Electron main process: window, tray, protocols, IPC, screen-share handling |
| [`preload.js`](discord-renewed/preload.js) | Injected UI: settings tabs, backgrounds, Customisation Mode, mini-player |
| [`webpack.js`](discord-renewed/webpack.js) | Runtime patcher for Discord's webpack modules |
| [`nativebridge.js`](discord-renewed/nativebridge.js) / [`native-modules.js`](discord-renewed/native-modules.js) | `DiscordNative` desktop-spoof shim and native module bridge |
| [`rpc.js`](discord-renewed/rpc.js) | Rich Presence IPC server |
| [`spotify.js`](discord-renewed/spotify.js) | Spotify auth (PKCE) and playback API |

## Running it

Requires [Node.js](https://nodejs.org/).

```bash
cd discord-renewed
npm install
npm start
```

## Disclaimer

Third-party Discord clients are against Discord's Terms of Service. This project
is for learning and portfolio purposes, and anyone who uses it does so at their own risk.
