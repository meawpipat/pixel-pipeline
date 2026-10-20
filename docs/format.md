# Export format

`pixelpipe export <group>` writes to `art/export/<species>/`. It does **not** scale or dither: the consumer scales first, then dithers at its own screen pixels, so every consumer shows the same pattern at the same scale.

## Per frame
| Part | Size | Layout |
|------|------|--------|
| `px` | 1024 B | 64×64 at 2 bits/pixel, row-major from the top row; the leftmost pixel of each byte is in bits 7–6 (then 5–4, 3–2, 1–0). Values: 0 black, 1 dark grey, 2 light grey, 3 white. Transparent pixels are 3. |
| `mask` | 512 B | 64×64 at 1 bit/pixel, row-major, MSB = leftmost pixel. 1 = opaque (draw), 0 = transparent (leave the background). |
| `ref_x`, `ref_y` | 1 B each | Bottom-centre of the frame's opaque bounding box (canvas pixels; `(0, 0)` for an empty frame). Used by the `sprite` dither anchor. |

## Files
- **`<group>.h`** — C header: `<group>_<anim>_<NN>_px[1024]` and `_mask[512]` (`PROGMEM`), a frame table `pp_frame_t <group>_<anim>[]` of `{ px, mask, ref_x, ref_y }`, `<GROUP>_<ANIM>_COUNT`, `<GROUP>_DITHER_ANCHOR_SPRITE` (0/1), and once per translation unit the tiles `pp_tiles[4][2][2]` and the renderer `pp_draw`. `-fat` becomes `_fat` in symbols. Headers exported with different tiles stop compilation with an `#error`.
- **`<frame>.bin`** — `px` (1024) + `mask` (512) + `ref_x` + `ref_y` = **1538 bytes**, no header.
- **`<frame>.png`** — indexed PNG: the 4 greys plus a transparent entry.

When a group is exported again, its files that this export does not write (removed frames, formats not requested, older formats) are moved to `art/_removed/`, never deleted.

## Drawing rule (what `pp_draw` does)
Draw a sprite at integer scale `s` with its top-left canvas pixel at screen `(X0, Y0)`. A screen pixel `(X, Y)` covered by an opaque canvas pixel with value `v` is black iff

```
tile[v][(Y − Y0 − ay·s) mod 2][(X − X0 − ax·s) mod 2] == 1
```

where `mod` is the non-negative remainder (`& 1` in C) and `(ax, ay)` is `(0, 0)` for the `canvas` anchor or `(ref_x, ref_y)` for the `sprite` anchor. The phase is relative to the sprite, so moving the sprite never makes its shading crawl; the `sprite` anchor also keeps the pattern fixed to the body when it bobs by one pixel at an odd scale.

Default tiles (from the config, `1` = black): black `11/11`, dark grey `10/01` (50 % checker), light grey `10/00` (25 % dots), white `00/00`.

```c
void plot(int x, int y, int black) { if (x >= 0 && y >= 0 && x < 200 && y < 200) set_pixel(x, y, black); }
pp_draw(&blob_s1_idle[frame], 4, 4, 3, BLOB_S1_DITHER_ANCHOR_SPRITE, plot);
```
`pp_draw` does not clip (`x0`/`y0` may be negative); `plot` must ignore pixels outside the screen. It reads the arrays by plain pointer access (valid on ESP32); on AVR include the header after `<avr/pgmspace.h>` and read with `pgm_read_byte`.
