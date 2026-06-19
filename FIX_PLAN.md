# Horizon Watchface — Fix Plan

Reference document for the timezone-picker and menu-icon fixes.
Tracking branch: `claude/watchface-timezone-picker-fixes-nrs4dq`.

---

## Fix 1 — Time zone picker "stuck to Vancouver" (CORE — isolated commit)

### Problem
`src/pkjs/index.js` (added in commit `9109ca6`) builds the manual-location
override in the `webviewclosed` handler like this:

```js
locopts = {
    automatic: !!dict[keys.LOCATION],
    latitude:  cityData.latitude,
    longitude: cityData.longitude,
    timezone:  new Date().getTimezoneOffset() * -1  // phone's live TZ offset
};
```

The `CITIES` table already carries a per-city UTC offset
(`timezone`, in minutes), but the manual override **ignores it** and always
sends the *phone's* offset. Result: selecting any city keeps the phone's
zone (Vancouver for the reporter), so the sun arc never matches the chosen
city. In `main.c` the offset is applied as
`sunRise = g.location.sunrise + timezone`, so a wrong offset rotates the
whole solar display.

### Fix (minimal, JS-only)
Use the selected city's offset for the manual override:

```js
timezone: cityData.timezone   // use the selected city's UTC offset
```

- **Manual mode** now honors the picked city's zone.
- **Auto (GPS) mode** is unaffected: when `automatic` is true, the override
  is skipped and `locationSuccess()` recomputes the offset from the phone
  (correct, since the phone is at the GPS fix). This is what restores sane
  auto-detection behavior alongside the manual fix.

### Known limitation
The `CITIES` offsets are fixed (e.g. Vancouver `-420` = PDT). A manually
picked city will not auto-adjust for DST. This is acceptable for a manual
fallback and is a large improvement over "always the phone's zone." A future
enhancement could store standard offset + DST rule per city.

### Risk / scope
Single-line change in `src/pkjs/index.js`. No C changes, no message-format
changes. Committed on its own per the core-change isolation rule.

---

## Fix 2 — Menu icon missing on the watchface selector (cosmetic — separate commit)

### Problem
`resources/images/icon.png` is a 25×25 **fully-opaque, full-color** scene
(yellow sky / blue horizon / sun). Pebble's launcher renders the menu icon
from image luminance + alpha; a fully-opaque image has no transparency to
shape the glyph, so it shows as a filled block rather than a clean icon.

### Fix
Replace the menu icon with a **white-on-transparent silhouette** (sun disc
over a horizon line), 25×25, matching the "Horizon" theme. White +
transparent is the most legible form for the monochrome launcher. The
`package.json` resource entry (`MENU_ICON`, `menuIcon: true`) is already
correct and needs no change.

### Risk / scope
Asset-only change. No code impact. Separate commit from Fix 1.

---

## Fix 3 — Automatic GPS not working / "hard lock" (CORE — isolated commit)

### Problem
The watch only recomputes the sun arc when it receives a message containing
`TIMESTAMP` (in `main.c`, the `MESSAGE_KEY_TIMESTAMP` handler is what calls
`configureClock()` + `animateClock()`). In automatic mode the only thing that
sends `TIMESTAMP` is a successful GPS fix via `locationSuccess()`.

Commit `0a3a39d` changed the geolocation request to:
```js
enableHighAccuracy: true,
timeout: 60 * 1000,
maximumAge: 0          // "always request fresh location"
```
Requesting a brand-new high-accuracy fix (no cache, 60 s window) routinely
fails — indoors, and on a watchface whose JS runtime is killed before a slow
fix returns. On failure `locationError()` only logged and **sent nothing**,
so the display never updated: the reported hard lock.

### Fix (JS-only, `src/pkjs/index.js`)
1. Relax the request — sun times need only city-level accuracy:
   ```js
   enableHighAccuracy: false,
   timeout: 15 * 1000,
   maximumAge: 30 * 60 * 1000   // a recent cached fix is fine
   ```
   A cached/coarse fix returns almost instantly, avoiding the JS-kill race.
2. Persist the last good fix in `locationSuccess()`.
3. In `locationError()`, fall back to that last fix (with a refreshed
   timestamp) so the watch always gets a `TIMESTAMP` update and can never
   hard-lock.

### Risk / scope
`src/pkjs/index.js` only; no C or message-format changes. Coarse location
changes sunrise/sunset by seconds at most. Isolated commit.

### Note for testing
All three fixes are in PebbleKit JS / resources — the watchface must be
**rebuilt and reinstalled** for them to take effect.

---

## Fix 4 — Battery drain, Phase 1: precompute static dial geometry (CORE — isolated commit)

### Problem
`drawClock()` re-rasterizes the entire vector scene every minute, even though
only the sun marker and time digits change minute-to-minute. As a first,
zero-risk step, the 24 orbit pips and 4 hour labels recomputed their positions
(`clockPoint()` trig) and the labels re-ran `snprintf("%02d")` on every redraw,
despite depending only on `g.rotation.current` — which changes only during the
rare ~1s animations, not on ordinary minute ticks.

### Fix (`src/c/main.c`, no visual change)
- Cache pip/label positions as offsets from center: `g.pipPoints[24]`,
  `g.labelPoints[4]`.
- New `recomputeOrbit()` fills them from `g.rotation.current`; called only
  where rotation changes: `init()` (after the boot rotation is set),
  `animateClock()` skip-path, and `interpolateClock()` (per animation frame).
- `drawClock()` pip/label loops read the cached offsets (`+ fcenter`) instead
  of recomputing trig; hour labels use a constant `kHourLabels[]` table,
  dropping the per-frame `snprintf`.
- Output is pixel-identical (`clockPoint` is linear in center, so
  `offset + fcenter == clockPoint(fcenter, …)`).

### Risk / scope
Removes 28 trig evals + 4 `snprintf` per minute. ~112 bytes of added state.
Modest but free saving; the large win is Phase 2 (static-dial cache), below.

### Note for testing
C change — must be **rebuilt** (chalk emulator + on-device). Verify the dial is
visually identical and that pips/labels still animate on a day rollover /
location update before merging to `main`.

---

## Fix 5 — Battery drain, Phase 2: static-dial bitmap cache (CORE — isolated commit)

### Problem
Even after Phase 1, `drawClock()` re-rasterizes ~30 fctx shapes (24 pips, 4
labels, readout disc, rings, battery/bluetooth dishes) every minute, while only
the sun marker and time/date actually change. fctx rasterization is the
dominant per-minute cost and the main battery difference vs. lighter faces.

### Fix (`src/c/main.c`, color platforms only)
- Split the renderer: `drawStaticDial()` (background, horizon, pips, labels,
  readout disc, battery, bluetooth, rings) and `drawFace()` (sun marker +
  time/weekday/date). The sun (orbit radius 62) never overlaps the readout
  disc (radius 52), so deferring it to `drawFace()` is output-neutral.
- Cache the static dial in a framebuffer-sized `GBitmap` (`g.dialCache`). Each
  minute: if the cache is valid, restore it with a per-row copy (`copyRows`,
  correct for both rectangular and round/circular framebuffers) and draw only
  the face. On a state change, full-render then re-capture into the cache.
- Invalidation (`invalidateDialCache()`): rotation/horizon (animate skip +
  interpolate), palette (`applyPalette`), battery, bluetooth, and an `isNight`
  flip (compared in `drawClock`).
- Safety: cache allocated lazily with a NULL-check fallback to the original
  full redraw (`dialCacheFailed`); bypassed entirely while the screen is
  obstructed (Quick View). `#ifdef PBL_COLOR` — aplite/diorite keep the
  existing path. Freed in `deinit()`.

### Risk / scope
Higher-risk core-rendering change. Per-minute work drops from ~30 fctx fills to
one bitmap copy + sun + text. Extra RAM ≈ framebuffer size (chalk ~32 KB of
64 KB; fallback covers any allocation failure).

### Note for testing
**Must be rebuilt and tested on-device (chalk).** Verify: pixel-identical dial;
sun moves each minute; smooth animation on day rollover / location update;
readout disc + text invert correctly across sunrise/sunset; battery + bluetooth
indicators update; `heap_bytes_free()` headroom is positive on chalk.

---

## Delivery
1. Commit Fix 1 (timezone) on its own.
2. Commit Fix 2 (icon) on its own.
3. Commit Fix 3 (GPS reliability) on its own.
4. Commit Fix 4 (battery Phase 1) on its own.
5. Commit Fix 5 (battery Phase 2) on its own.
6. Push `claude/watchface-timezone-picker-fixes-nrs4dq`; merge to `main`
   (owner-authorized).
