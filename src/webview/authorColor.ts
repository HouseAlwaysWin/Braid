/**
 * One stable colour per author.
 *
 * The point is scanning: in a list where every name is the same grey, telling "who wrote this run
 * of commits" apart takes reading. A tint answers it before you read anything.
 *
 * Two decisions worth stating, because the obvious alternatives are both worse:
 *
 * - **The colour is derived from the name, not handed out in order of appearance.** History
 *   arrives in pages while you scroll, and a ref or author filter changes which commits arrive at
 *   all - so "first seen gets colour 0" would give the same person a different colour depending on
 *   how far you had scrolled or what was filtered. Hashing has no such state.
 * - **Only the hue is chosen here.** Lightness and chroma live in the stylesheet, per theme, so
 *   every author lands at the same perceived lightness and the column keeps the visual weight it
 *   had as plain grey text. A fixed list of hex colours could not do that: yellow and blue with
 *   the same sRGB "brightness" are nowhere near equally readable.
 */

/**
 * How many distinct tints exist.
 *
 * Twelve rather than as-many-as-possible. Hues closer together than 30 degrees stop reading as
 * different colours and start reading as a rendering bug - the reader wonders whether those two
 * names are the same person. Repeating a colour after twelve authors is the honest failure: it
 * says "colours ran out", which is understood, instead of implying a distinction that is not
 * visible. `scripts/color-check.mjs` measures both claims against this number.
 */
export const AUTHOR_HUES = 12;

/**
 * The tint for an author name, in degrees, for `oklch()`.
 *
 * FNV-1a over UTF-16 code units: small, dependency-free, and well spread over short strings -
 * including CJK names, which `charCodeAt` handles as ordinary code units.
 *
 * The key is the displayed name (`%aN`, so mailmap has already merged identities). Two people who
 * genuinely share a display name share a colour, but they also share every visible character in
 * this column, so the colour is not hiding a distinction the column was showing.
 */
export function authorHue(name: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    // Math.imul, because `hash * prime` overflows into a double and loses the low bits that carry
    // the mixing.
    hash = Math.imul(hash, 0x01000193);
  }

  return ((hash >>> 0) % AUTHOR_HUES) * (360 / AUTHOR_HUES);
}
