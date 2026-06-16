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

## Delivery
1. Commit Fix 1 (timezone) on its own.
2. Commit Fix 2 (icon) on its own.
3. Commit Fix 3 (GPS reliability) on its own.
4. Push `claude/watchface-timezone-picker-fixes-nrs4dq`.
5. Merge to `main` (explicitly authorized by the owner) and push `main`.
