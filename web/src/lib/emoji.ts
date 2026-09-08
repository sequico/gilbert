/**
 * Emoticons rendered the WhatsApp way: yellow and coloured, everywhere,
 * whatever fonts the operating system has.
 *
 * The chat stores emoticons as plain text (ADR 0006) and inserts them as
 * unicode into the draft; *this* module is only about how they are drawn.
 * Each known emoticon maps to a bundled Twemoji image (Twitter's emoji set,
 * CC-BY 4.0, © Twitter — yellow faces in the WhatsApp spirit), served from
 * this app's own /img/emoji so nothing is fetched from a third party. An
 * emoticon outside this fixed set still renders as text, exactly as typed.
 *
 * The map key is the exact unicode sequence (including variation selectors
 * such as the heart's U+FE0F), the value the Twemoji asset stem:
 * https://github.com/twitter/twemoji (assets/72x72/<stem>.png). See
 * web/public/img/emoji/README.md for the licence and source.
 */
import { withBase } from "@/lib/basePath";

/** The fixed grid of common emoticons offered by the chat picker. */
export const COMMON_EMOJI = [
  "😀",
  "😄",
  "😂",
  "🤣",
  "😊",
  "😍",
  "😘",
  "😉",
  "🙂",
  "😎",
  "🤔",
  "😅",
  "😢",
  "😭",
  "😡",
  "🥳",
  "😇",
  "🥺",
  "😴",
  "🤗",
  "🫶",
  "❤️",
  "💔",
  "👍",
  "👎",
  "🙏",
  "👏",
  "🤝",
  "💪",
  "🙈",
  "🙉",
  "🙊",
  "🔥",
  "✨",
  "🎉",
  "✅",
  "❌",
  "💯",
  "👀",
  "☕",
  "🍕",
  "🚀",
  "🌹",
] as const;

/** Emoticon → Twemoji asset stem (lowercase hex code points, '-'-joined). */
export const EMOJI_ASSET: Readonly<Record<string, string>> = {
  "😀": "1f600",
  "😄": "1f604",
  "😂": "1f602",
  "🤣": "1f923",
  "😊": "1f60a",
  "😍": "1f60d",
  "😘": "1f618",
  "😉": "1f609",
  "🙂": "1f642",
  "😎": "1f60e",
  "🤔": "1f914",
  "😅": "1f605",
  "😢": "1f622",
  "😭": "1f62d",
  "😡": "1f621",
  "🥳": "1f973",
  "😇": "1f607",
  "🥺": "1f97a",
  "😴": "1f634",
  "🤗": "1f917",
  "🫶": "1faf6",
  "❤️": "2764",
  "💔": "1f494",
  "👍": "1f44d",
  "👎": "1f44e",
  "🙏": "1f64f",
  "👏": "1f44f",
  "🤝": "1f91d",
  "💪": "1f4aa",
  "🙈": "1f648",
  "🙉": "1f649",
  "🙊": "1f64a",
  "🔥": "1f525",
  "✨": "2728",
  "🎉": "1f389",
  "✅": "2705",
  "❌": "274c",
  "💯": "1f4af",
  "👀": "1f440",
  "☕": "2615",
  "🍕": "1f355",
  "🚀": "1f680",
  "🌹": "1f339",
};

/** The bundled image for one emoticon sequence, or null if it is not in the set. */
export function emojiAsset(sequence: string): string | null {
  const stem = EMOJI_ASSET[sequence];
  return stem ? withBase(`/img/emoji/${stem}.png`) : null;
}
