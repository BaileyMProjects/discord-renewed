# Discord Renewed

A custom Discord **desktop client** that loads the real Discord and layers in
built-in, settings-driven customization (backgrounds, colors, fonts) through a
proper UI — the polish of native settings with the power of BetterDiscord.

> Working title. Private/personal project by Bailey Montoya.

## Stack

- **[Electron](https://www.electronjs.org/)** — runs Discord's web app inside our
  own desktop window. Electron ships prebuilt, signed binaries, so it builds
  without local native compilation.

## How it works

`main.js` is the Electron *main process*. It opens a window and loads the real
Discord web app (`https://discord.com/app`), spoofing a Chrome user-agent so
Discord doesn't reject it as an "unsupported browser". Customization will be
injected later through a preload script.

## Run it

```bash
npm install   # first time only — downloads Electron
npm start     # opens the Discord Renewed window
```

## Roadmap

- [x] Minimal Electron window that loads Discord
- [ ] **MVP-0:** set a custom background image via a button
- [ ] Settings UI (colors, fonts)
