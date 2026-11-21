# Materials first: the hero should not be only type and cards

When everything on a page is type, cards, tables and hairlines, every style looks thin. Decide each design's hero
material before its layout, and get the images the content needs before designing.

## Principles

1. **Each direction names its hero material** (the card in `references/directions.md`). Pure typography is fine when
   it is deliberate: type made into an image (huge, vertical, cropped by the edge), not a heading over a paragraph.
2. **Images the content needs come first.** A page about an animal, a place, a person, a product or a period carries
   pictures as content, not decoration: a parrot site without parrots has failed. When unsure, treat it as needed.
3. **The honesty test:** remove the image; is information lost? If not, it is decoration: leave it out. No stock
   "inspiration" pictures.
4. **Where a picture belongs, put a picture.** Never an emoji, a hand-drawn SVG person or object, or a grey block
   saying "image" in its place: avatars, dishes, products, rooms, landscapes, covers, illustrations, characters, the
   main visual. People spot those at once as unfinished AI work. Geometry, icons, charts and map lines are drawn in code,
   as they should be; a silhouette mask is for composition (cropping a photo), never a product's stand-in.

The person's own product or face: use their real assets (ask for them, or follow the `brand-extract` skill's sources);
never invent them.

## Where images come from, in this order

1. **Generated, with `image_generate`**, for "a thing of this kind" (a bowl of noodles, a living room, someone
   running). It spends the owner's money: say how many images you plan before the first, make one per spot, look at it
   (`read` the file), and make a second only when the first doesn't fit. Write the page's main colour, light and
   framing into the prompt, and the concrete subject, angle, light and material, never "premium" or "minimal".
2. **Open-licensed real photographs**, for "this one thing" (a real place, an artwork, a named product, a real person),
   where a generated one would be false. Wikimedia Commons first (Openverse, Unsplash or Pexels next), with its
   licence and author:

   ```bash
   curl -s -G https://commons.wikimedia.org/w/api.php -A pi-phone \
     -d action=query -d generator=search -d gsrnamespace=6 -d gsrlimit=5 \
     --data-urlencode "gsrsearch=filetype:bitmap <English keywords>" \
     -d prop=imageinfo -d 'iiprop=url|extmetadata' -d iiurlwidth=1600 -d format=json
   # each page: imageinfo[0].thumburl, extmetadata.LicenseShortName, extmetadata.Artist (HTML)
   curl -sL -A pi-phone -o img/<name>.jpg '<thumburl>'
   ```

   A CC BY or CC BY-SA image carries its author and licence on the page or in the delivery note.
3. **None fits:** stop and tell the person in one sentence which images are missing and what would get them (an image
   model in Settings, their own photos). Leave those spots visibly empty and say so in the first line of the delivery
   note. That is unfinished work, not a way of working.

When a source fails (quota, a refusal, nothing found), go one step down this list, or choose a picture that is easier
to get (no photo of the finished dish: its ingredients), never back to emoji or colour blocks.

In the three-directions process, each draft gets its hero material in this order before anything is shown: the person
chooses what they can see.

**In an artifact,** images must travel inside the page: shrink them first (the `media` tool's `image` action, about
1600 px wide, jpg or webp), then embed them as data URIs; a full `https://` address of an open-licensed original also
works.

## Materials code can make

Without any image source, the page still has more than type and cards:

- **Procedural texture:** SVG filters (`feTurbulence` with `feDisplacementMap` for paper grain, noise, ink bleed,
  misregistered print); layered `radial-gradient` for light and volume; `mask-image` and `clip-path` for silhouettes and
  crops; `mix-blend-mode` for overprint; canvas for contour lines, dot fields, flow fields, star charts, woven textures
  (with a fixed random seed, so screenshots repeat); Three.js from a CDN for procedural geometry and light.
- **Data as the image:** the content's numbers made into the main visual (a scale across the whole page, objects at
  true relative size, a route on a map) instead of three big-number cards.
- **Replicas:** a ticket, a label, an ID card, a manual, a postcard, a newspaper page in HTML, with paper, punch holes,
  stamps and folds, when the content is one.
- **Type as image:** huge letterforms cut by the frame, vertical setting, letters locked with a photo.

---
Adapted for pi-phone from `references/materials.md` of [huashu-design](https://github.com/alchaincyf/huashu-design)
by alchaincyf (花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
