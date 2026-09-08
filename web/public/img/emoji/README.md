# Emoticon images

The PNGs in this directory are **Twemoji** (Twitter's emoji set), which Gilbert
bundles so chat emoticons render yellow and coloured (WhatsApp style)
whatever fonts the operating system provides.

- Source: https://github.com/twitter/twemoji (assets/72x72)
- Version: 14.0.2
- Licence: CC-BY 4.0 — © Twitter, Inc and other contributors
  (https://creativecommons.org/licenses/by/4.0/)
- Mapping: web/src/lib/emoji.ts (unicode sequence → asset stem). The emoticon
  is stored and sent as plain text (ADR 0006); the image is display only.
