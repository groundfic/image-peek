# Image Peek

Quick Look–style image preview for Obsidian — like pressing Space in Finder, or tapping an image in Apple Freeform.

The preview zooms out from the thumbnail's position (FLIP animation), supports pan/zoom, and closes right back into place.

<img width="100%" alt="Kapture 2026-06-13 at 00 06 29" src="https://github.com/user-attachments/assets/ddf0e15b-ac9b-4437-9071-22c1e594cda8" />

## Usage

| Action | Behavior |
|---|---|
| Double-click an image (desktop) | Open the preview, zooming from the thumbnail |
| Single tap (mobile, in notes) | Open the preview |
| Double tap (mobile, on Canvas) | Open the preview; single tap keeps node selection |
| Hover an image + `Space` | Open the preview (never triggers while typing) |
| Select an image node on Canvas + `Space` | Open the preview (Freeform-style) |
| `Space` / `Esc` / click backdrop | Close, zooming back into place |
| `←` `→` | Browse other images on the same page |
| Scroll wheel / pinch | Zoom centered on the cursor (or pinch midpoint) |
| Drag / one-finger pan | Pan |
| Double-click / double tap | Toggle fit ↔ 2× |
| Title-bar buttons | Share / Copy image / Open in default app / Reveal in Finder |

Single clicks and modifier-key clicks are never intercepted — Obsidian's native behavior is preserved.

- **Copy image** works for all images, including external ones
- **Share** opens the Apple share sheet on macOS and the system share sheet on mobile (hidden on Windows/Linux desktop)
- **Open in default app** and **Reveal in Finder** apply to vault images on desktop only

## Settings

- **Click image to open preview** — desktop double-click / mobile tap behavior
- **Space key to open preview** — hover or Canvas-selection + Space
- **Show action buttons** — toggle the title-bar buttons
- **Excluded images (CSS selectors)** — containers whose images should not trigger the preview (defaults to excluding Link Card Preview cards)
- **Backdrop blur** — frosted-glass backdrop; turn off on lower-powered devices

## Privacy & network usage

This plugin makes no network requests of its own. The only network activity occurs when you use **Copy image** or **Share** on an image that is itself hosted externally — the image is fetched once so it can be placed on the clipboard or share sheet. No analytics, no telemetry.

## A note on internal APIs

"Open in default app" and "Reveal in Finder" use two Obsidian APIs that are not part of the public type definitions (`app.openWithDefaultApp`, `app.showInFolder`). They are widely used across community plugins and stable in practice, but may change in future Obsidian versions. If they ever break, only these two buttons are affected — the preview itself uses public APIs only.

## Installation

### From the Community plugin directory

Search for "Image Peek" in Settings → Community plugins.

### Manual

Copy `main.js`, `manifest.json`, and `styles.css` into `<your vault>/.obsidian/plugins/image-peek/`, then enable the plugin in Settings.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # compile main.js
```

## Known limitations

- Canvas image-node filename resolution relies on the node label; identically named files in different folders may resolve to the first match
- Possible future additions: rotation, video and PDF preview, ordered navigation across multi-selected Canvas nodes

## License

MIT
