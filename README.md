# RunTrack – GPS jogging tracker (static PWA, no build step, no API keys)

Files: `index.html` · `styles.css` · `app.js` · `sw.js` · `manifest.webmanifest` · `icon.svg`

## Run locally
`python3 -m http.server 8000` in this folder → open http://localhost:8000 (localhost counts as secure, so GPS works on the desktop).

## Test on your phone (GPS needs HTTPS)
1. **Easiest:** deploy (below), open the https URL on the phone.
2. Or tunnel your local server: `npx localtunnel --port 8000` (or `cloudflared tunnel --url http://localhost:8000`).
3. Android + USB: Chrome DevTools → Remote devices → port-forward 8000, open `localhost:8000` on the phone.

## Deploy
- **GitHub Pages:** push the folder to a repo → Settings → Pages → deploy from `main` / root.
- **Netlify:** drag the folder onto app.netlify.com/drop. Both give HTTPS automatically.
- When you change files, bump `runtrack-v1` in `sw.js` so phones fetch the update.
- For reliable "Install app" prompts, also add 192×192 and 512×512 PNG icons to the manifest (export from `icon.svg`); iPhone uses Share → Add to Home Screen.

## Tuning GPS filters
`CFG` at the top of `app.js`: `maxAcc` (reject fixes worse than ±25 m), `minStep` (ignore tiny drift), `maxSpeed` (reject jumps >11 m/s), `gapSec`.

## How to test
- **Walk outside** with Start → check distance rises, accuracy pill shows ±m, route draws, map follows; drag map → Recenter appears.
- **Distance check:** run/walk a known 400 m track lap; expect roughly 0.38–0.42 km.
- **Voice / km:** set a 1 km goal; at 1.00 km you hear the km announcement then goal announcement and see the celebration. Use *Test announcement* indoors first.
- **Pause:** pause, walk 50 m, resume → distance unchanged during pause, route not joined across it.
- **Timer:** pause for a minute; time must not advance. Lock/unlock the phone; time stays correct.
- **Wake lock:** pill says "kept awake" while running; switch tabs and back → reacquired.
- **Refresh:** reload mid-run → "Unfinished run found" banner (restores paused, up to ~5 s lost).
- **Permission denied:** block location for the site, tap Start → inline error, app returns to ready.
- **History:** finish a run, reload, open History → view route, delete, clear all.
- **Indoor dry-run:** Chrome DevTools → Sensors → set/override location and change it between points.

## Browser compatibility (from general knowledge – verify on your device)
| Feature | Android Chrome | Android Firefox | iPhone Safari | Desktop Chrome |
|---|---|---|---|---|
| Geolocation (HTTPS) | Yes | Yes | Yes, foreground only | Yes, but coarse (Wi-Fi/IP) |
| Speech synthesis | Yes | Yes, voices vary | Yes, first speech needs a tap; silent when locked | Yes |
| Wake Lock | Yes | Recent versions | iOS 16.4+, can be flaky in home-screen apps | Yes |
| Web Audio beeps | Yes | Yes | Yes, after a tap | Yes |
| IndexedDB | Yes | Yes | Yes (Safari may evict data of rarely used sites) | Yes |
| Install as app | Yes | Partial | Manual (Add to Home Screen) | Yes |

## Limitations (unavoidable in a web page)
- **No background tracking.** If the screen locks, you switch apps or the browser is suspended, GPS updates and speech can stop. Keep the screen on and the page in the foreground. Distance during a gap is added as a straight line only if the implied speed is plausible; otherwise it is skipped.
- Voice can stay silent when the phone is locked or on silent mode, and on some browsers until the first tap.
- Map tiles need internet; only the app shell works offline. Tracking, distance and history work offline.
- Browser GPS is typically ±5–15 m; expect distance within a few percent, less accurate under trees/buildings.
- Average pace = active time ÷ distance; paused time is excluded.

## Privacy
Routes and history never leave the device. The only network requests are to cdnjs.cloudflare.com (Leaflet) and tile.openstreetmap.org (map tiles; those servers see your IP and the map area you view). OSM's public tile servers are for light use under their tile usage policy; for heavy use, switch the tile URL in `app.js` to a provider you have an account with.
