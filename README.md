# Spotify Stage

Second-screen WebGL music visualizer for Spotify with 8-bit Bayer-dithered worlds, an editorial Reels typography stage, real-time audio reactivity, and synced word-by-word lyrics.

## Features

- **6 WebGL Scenes**: `Ocean`, `Plasma`, `Tunnel`, `Kaleido`, `Echo` (MilkDrop-style 8-bit feedback trails), and `Type` (Editorial Reels montage with 3D camera transitions and ambient cover backdrop).
- **Auto VJ Mode**: Automatically cycles scenes on bass drops (when live audio is active) or on a timer using an 8-bit Bayer diamond wipe.
- **Album Cover Palette**: Extracts dominant colors from the active Spotify track cover and smoothly transitions scene lighting and typography (plus 4 manual 8-bit presets: `Game Boy`, `Sunset`, `Cyber`, `Crimson`).
- **Live Audio Reactivity**: Supports both browser tab/system audio capture (`A`) and microphone input (`M`) with adjustable sensitivity (`Gain`).
- **Synced Lyrics & 60 FPS Parabolic Bouncing Ball**: Fetches time-coded lyrics from `lrclib.net` with 3 modes (`Kinetic`, `Scroll`, `Off`), an 8-bit/editorial font switch (`F`), and a continuous 60 FPS bouncing orb.
- **Spotify OAuth PKCE**: Runs entirely in the browser with no backend required, plus a built-in Demo Stage when disconnected.

## Quick Start

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/` in your browser.

### Connecting Spotify

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and enable **Web API**.
2. Add `http://127.0.0.1:5173/` to **Redirect URIs**.
3. Click **Подключить Spotify** in the app and paste your **Client ID**.

## Shortcuts

| Key | Action |
| --- | --- |
| `0` | Auto VJ |
| `1`–`6` | Switch scenes (`Ocean`, `Plasma`, `Tunnel`, `Kaleido`, `Echo`, `Type`) |
| `Space` | Play / Pause |
| `A` | Capture tab / system audio |
| `M` | Toggle microphone |
| `L` | Cycle lyrics mode (`Kinetic` / `Scroll` / `Off`) |
| `F` | Toggle 8-bit / serif lyric font |
| `G` | Open palette & audio gain panel |
| `S` | Save PNG poster |
| `H` | Pin / auto-hide HUD |
