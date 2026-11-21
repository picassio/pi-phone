# A brand's assets: logo first, then its products, then its colours

When a design involves a real brand or product (the person names a product, a company or a client; a deck that
compares five named tools; a launch page for their own company), get **its assets** before you design, whether or not
the person sent any. A brand is what people recognise, and they recognise it by these, in this order:

| Asset | How much it is recognised by | Needed |
|---|---|---|
| **Logo** | Most: a logo alone names the brand | Always, for every brand and every product named |
| **Product photos or renders** | Very much: a physical product's hero is the product | For physical products (hardware, packaging, goods) |
| **Screenshots of its interface** | Very much: a digital product's hero is its interface | For apps, sites, SaaS |
| Colours | Some: alone they are often shared with others | Helps |
| Typefaces | Little, without the above | Helps |
| Mood words | For your own checks | Helps |

So: measuring colours and fonts (this skill's steps 1 and 2) without the logo, the product or the interface misses the
point. Drawing the product in CSS or SVG in place of a real picture makes a generic tech page any brand could own.
Never go on silently without the assets: say what is missing, get it generated from a real reference, or ask.

First make sure the product exists and what state it is in (released, its current version): `web_search` it.

## 1. Ask once, with the whole list

Not "do you have brand guidelines?", which nobody knows how to answer. One `interview` (or one short message) with:

1. Logo (SVG, or a large PNG): needed for any brand.
2. Product photos or official renders: needed for a physical product.
3. Screenshots of the interface: needed for a digital product.
4. Colours (hex, a palette).
5. Typefaces (display, body).
6. Guidelines, a design system file, or the brand's site.

Say that what they do not have, you will find, measure or generate.

## 2. Look in the official places

| Asset | Where |
|---|---|
| Logo | `<brand>.com/brand`, `/press`, `/press-kit`, `brand.<brand>.com`, the inline SVG in the site's header |
| Product pictures | The product page's hero and gallery, the press kit, the press release's images, frames of the official launch film |
| Interface | The App Store or Google Play page's screenshots, the site's screenshots section, the official demo video, the brand's posts at launch, the person's own account |
| Colours | The site's CSS (this skill's `measure.js`), its guidelines |
| Typefaces | The site's loaded faces (`measure.js` lists them), its guidelines |

Search with `web_search` when the obvious addresses fail: "<brand> logo SVG", "<brand> press kit", "<brand>
<product> official renders", "<brand> app screenshots". Read pages with `fetch_content`; a page that needs scripts
or clicks, in Pi's browser.

## 3. Get the files

Save them in a folder beside the work (`assets/<brand>/`), with `curl -L` in `bash`.

**The logo,** in this order (most sites are script-built now, so `<brand>.com/logo.svg` usually returns an empty HTML
shell: do not stop there):

1. **svgl**, best for software, AI and developer brands (light and dark versions, wordmarks):
   `curl -s "https://api.svgl.app?search=<brand>"` answers JSON; download its `route` (or `route.light`,
   `route.dark`, `wordmark`) with `curl -L`.
2. **Simple Icons**, one-colour glyphs in the colour you ask: `curl -L -o logo.svg
   "https://cdn.simpleicons.org/<slug>/<hex without #>"`.
3. The brand's own page (`/brand`, `/press`): the file it offers.
4. The inline SVG in the site's header: in Pi's browser, `browser_eval` with
   `document.querySelector('header svg, a[href="/"] svg')?.outerHTML`.
5. The site's icon, which almost never fails: `curl -L -o logo.png
   "https://www.google.com/s2/favicons?domain=<domain>&sz=256"` (it redirects: keep `-L`; it may answer a JPEG
   smaller than asked, so check it as below).
6. Last: the brand's avatar on GitHub, X or LinkedIn (often 400 px or larger, transparent).

**Product pictures:** the product page's hero (often 2000 px or more), the press kit, a frame of the launch film when
you have the file (`media` `frames`), Wikimedia Commons with its credit; or `image_generate` with the real photo in
`images`, asking for the scene you need. Never a CSS silhouette.

**Interface:** store screenshots (they may be mockups: compare with the real thing), the site's, frames of the demo
video, the person's own screenshots, or `screenshot` with the live product's `url`.

**Check every file:** `file <it>` says SVG or PNG (not a 106-byte placeholder or an HTML page), `head -c 90` of an SVG
starts with `<svg`, and `read` it to see that it is the right mark.

## 4. The bar: five searches, ten candidates, two picks, each 8 of 10

The logo is different: when there is one, use it (a 6-out-of-10 logo beats none ten times over); when there is none,
stop and ask. Every other picture (products, interface, references) meets this bar:

- **Five searches** across different places (the site, the press kit, social posts, video frames, Wikimedia, the
  person's account), not the first two results.
- **Ten candidates** before choosing.
- **Two picks** from the ten: all of them is visual overload.
- **Each 8 of 10 or better**, scored on: resolution (2000 px or more, 3000 for print or big screens); clear rights
  (official, then public domain, then free licences; anything that looks lifted scores 0); fit with the brand's mood;
  light, framing and style that agree between the two; a picture that tells something on its own, not decoration.
  Under 8: leave it out, and use an honest placeholder that says what belongs there, or a generated one from an
  official reference.

## 5. Check and measure

| Asset | Check |
|---|---|
| Logo | The file opens; a version for dark grounds and one for light; a transparent background |
| Product pictures | One at 2000 px or more; a clean or removed background; several angles (hero, detail, scene) |
| Interface | Real resolution; the current version; no personal data in it |
| Colours | `measure.js` on the site (this skill's step 1), or count the hex values in the SVGs and CSS you saved, greys left out |

- **Demo colours are not the brand's:** a tool's screenshot often shows a customer's brand in its demo. With two strong
  colours on screen, tell them apart.
- **One brand, several faces:** its marketing site and its product UI often use different palettes. Both are real:
  choose the one that fits what you make.

## 6. Write it down: `brand-spec.md`

Beside the work, one file the whole design reads from:

```markdown
# <Brand> · brand spec
Collected: YYYY-MM-DD · Sources: <addresses> · Complete / partial / inferred

## Core assets
- Logo: assets/<brand>/logo.svg (dark grounds: logo-white.svg). Never stretched, recoloured or outlined.
- Product (physical): assets/<brand>/product-hero.png (2400 × 1600), detail-1.png, scene.png
- Interface (digital): assets/<brand>/ui-home.png, ui-<feature>.png

## Supporting
- Colours: primary #…, ground #…, ink #…, accent #… (each with its source); colours the brand never uses
- Type: display …, body …, mono …
- Signature details: what is done to 120 %
- No-gos: what this brand never does
- Mood: three to five words
```

Then design from it, by structure rather than memory:

- The logo and product pictures go in as `<img>` of the real files; never redraw a logo.
- Colours come from the spec as CSS variables (`:root { --brand-primary: …; }`), used only through `var()`: a new
  colour means changing the spec first.
- An artifact or a file to send is one file: embed the pictures as data URIs (`base64 -w0`), since the layout check
  flags pictures by a relative address there.
- **A comparison of named products** (a deck of five tools, a ranking): each one's logo, every time it is named.
  Being "only a comparison" does not excuse it.
- A logo identifies the product the design is about. The design must not pass itself off as the brand's own work
  unless the person is that brand.

## When something cannot be found

| Missing | Then |
|---|---|
| The logo | Stop and ask the person. Do not go on without it |
| Product pictures | `image_generate` from an official reference, then ask the person, then an honest placeholder labelled "product picture to come" |
| Interface screenshots | Ask for the person's own, then frames of the official demo; never a mockup generator |
| Colours | Derive them from the subject and real pictures (`design-artifact`'s `references/colour-type.md`), marked as assumed |

Getting this right takes about half an hour (the logo five minutes, three to five product or interface pictures ten,
colours five, the spec ten). Skipping it makes a page with no recognition, and an hour or two of rework.

---
Adapted for pi-phone from `references/brand-asset-protocol.md` of
[huashu-design](https://github.com/alchaincyf/huashu-design)
by alchaincyf (花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
