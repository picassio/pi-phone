# Colour and type: derive them, don't pick them

The hex values and font names in any style or system you read are anchors, not recipes. Copying them gives a hundred
people the same page; deriving them makes colour and type evidence of this subject.

## Colour in three steps: sample, converge, argue

1. **Sample.** Take the main colours from three sources, never from nowhere:
   - the brand's assets: its logo, its existing identity;
   - the content's real images: product screenshots, the photographs the page will carry;
   - the subject's culture: the colours it already carries in people's memory (the table below).

   A colour picked from nothing is a draw from the model's habits, and those habits keep drawing the same few colours.
   A well-known AI product's brand colours are not a safe default: they are the first sign of the default AI look.
2. **Converge in oklch.** Two or three chromatic colours and one neutral ramp. Write the neutrals as a lightness
   sequence (for example L 0.15 / 0.35 / 0.65 / 0.92 / 0.98: that is already the hierarchy), and keep chromatic colours
   apart by a hue angle of 60° or more, or a lightness gap of 0.3 or more. oklch keeps the hue steady when lightness
   moves, which hsl does not:

   ```css
   :root {
     --primary: oklch(0.62 0.14 155);       /* the moss green sampled from the subject's photos */
     --primary-light: oklch(0.85 0.06 155);
     --primary-dark: oklch(0.42 0.15 155);
   }
   ```
3. **Argue in one sentence** why this colour, in a comment in the page or in the delivery note: "the main colour is the
   ochre of the client's logo, chroma lowered to 0.08 to read as ink". **No sentence means you copied a recipe.**

With a brand colour, use it and fill missing tokens by oklch steps; with a reference but no brand, sample the
reference's screenshot; with neither, sample the subject.

### Chroma by area

Ink on paper never reaches a screen's full saturation; the "expensive" feel of print is that physical greyness.
Lowering chroma on screen borrows it.

| Use | oklch chroma | Effect |
|---|---|---|
| Large grounds | 0.01–0.04 | paper, easy on the eye |
| Brand colour, emphasis | 0.08–0.15 | ink: clear but not plastic |
| Small accents (buttons, links) | 0.15–0.22 | alive, in small areas only |
| Above 0.25 over large areas | rarely | screen glare; only for deliberately digital looks (a "Wrapped" recap, candy) |

### The same hue in different cultures

| Hue | Context A | Context B | The difference |
|---|---|---|---|
| Red | palace vermilion (orange-leaning, greyed, lower L and C) → tradition, ceremony | cola red (saturated true red) → consumer, excitement | lower the chroma and the shelf becomes a palace wall |
| Blue | indigo dye (deep, violet-grey) → craft, calm | tech blue (the #0066FF family) → SaaS, efficiency | the second is the model's favourite default: ask whether you are just drawing it |
| Green | matcha or moss (yellowish, low chroma) → nature, tea | neon green → terminal, hacker | one drinks tea, the other types code |
| Yellow | gamboge or mustard (brown-grey) → old print | warning yellow → loud, playful | the grey decides between an old page and a hard hat |
| White | cream paper (#F5F0E8) → publication, warm | pure white → lab, Swiss | a 2 % shift of temperature is the whole character |

## Type

Decide in this order: the face's job (display or text), the size scale, the measure and leading, then the pairing.
`text-wrap: balance` on headings of up to four lines, `text-wrap: pretty` on paragraphs. Embed faces as `@font-face`
data URIs, as the skill says; for Vietnamese, pick faces whose files carry the Vietnamese subset and look at the
diacritics on the screenshot.

**Where a pairing's contrast comes from** (choose one before choosing faces):

- **Form:** a serif display over a sans body (the classic; their x-heights must agree or sizes seem to jump).
- **One family:** a superfamily's serif and sans on one skeleton (no risk, at the price of calm).
- **Era:** an old letterform against a modern one (200 years or more apart makes tension; 50 only looks muddled).

**Ten open pairings** (display + body; all on Google Fonts or their makers' repositories, open licences):

| # | Pairing | Why it works | Temperature |
|---|---|---|---|
| 1 | Newsreader + Geist | Form: a screen-tuned transitional serif with a tall x-height that meets Geist; the honest replacement for Fraunces | quiet |
| 2 | Source Serif 4 + Source Sans 3 | One family: Adobe's shared system; heights, weights and rhythm align; reports and documents never fail | quiet |
| 3 | EB Garamond + IBM Plex Sans | Era: a 16th-century French serif against a 2017 grotesque; Garamond's x-height is low, so size it up about 8 % or use `font-size-adjust` | quiet, literary |
| 4 | Lora + Hanken Grotesk | Form: a brushy serif of medium contrast that reads well on screens; Hanken is an open cousin of Söhne | neutral |
| 5 | Instrument Serif + Geist | Form: one weight only, so display only, body goes to the sans; becoming an AI default, so think twice when the aim is to look distinct | neutral |
| 6 | Schibsted Grotesk + Source Serif 4 | Reversed: a grotesque display over a serif body, a newsroom feel (made for a Norwegian news group); the replacement for Space Grotesk | neutral |
| 7 | Bricolage Grotesque + Newsreader | Form: Bricolage's ink traps and quirks show only at large sizes; against a quiet serif body, rough meets refined | bold |
| 8 | Archivo (Expanded or Black) + Inter | Poster: Archivo's wide black weight carries the page, Inter only works the 14–16 px body (Inter's right job) | bold |
| 9 | Cormorant Garamond + Work Sans | High-contrast luxury: Cormorant's hairlines need 40 px or more, they break when small; fashion, catalogues | bold |
| 10 | Geist Mono or JetBrains Mono + Geist | Monospace as the lead: a command-line, engineering feel; mono for labels, numbers and code only, never whole paragraphs (lines grow about 30 %) | neutral, technical |

**Overused faces** (single faces used by AI tools until they say "default"; the replacement is usually better):

| Overused | Why | Instead |
|---|---|---|
| Fraunces as display | the "tasteful" default of AI design tools since 2023 | Newsreader, Libre Caslon Text |
| Inter as display | Inter is drawn for small UI text; large, it is even and expressionless | Archivo, Anton, Schibsted Grotesk |
| Space Grotesk | the lazy answer for "tech", everywhere on crypto and AI pages | Schibsted Grotesk, Familjen Grotesk |
| Playfair Display | the lazy answer for "elegant", a wedding-invitation look | Cormorant (more extreme), DM Serif Display (sturdier) |

A high-contrast serif on warm cream is a look family, not an overused face: use it when the subject argues for it, just
not in two of three directions, and not in every project (the look ledger keeps count).

**Chinese and other CJK text:** put the Latin face first in the stack and the CJK face after it, so Latin letters and
numbers take the Latin face; set CJK body text only in a Song, Hei or Kai face (the rest are display faces); at most
two CJK families on a page (each file is large); never italicise CJK (browsers slant it mechanically): change the
weight, highlight, or switch to a Kai face for quotations; tabular numbers in tables.

---
Adapted for pi-phone from `references/design-styles.md` (colour derivation), `references/typography.md` and
`references/content-guidelines.md` of [huashu-design](https://github.com/alchaincyf/huashu-design) by alchaincyf
(花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
