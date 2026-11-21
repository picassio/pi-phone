# Style catalogue: 92 styles in six media

A pool to draw from when you have no idea yet, and the pool of `references/directions.md`'s random pick. It is not a
menu the work must come from: when the person brings content, a brand or a reference, the design grows from that.

## How to use it

1. **Pick the section by what you deliver, not by the subject.** A site people click: Web. Pages that turn: Slides.
   One image (or a set) where data is the hero and reads without interaction: Infographics. A phone app or its
   prototype: App. A carousel of 3:4 images for Xiaohongshu (RED) or Instagram: Carousel. **East Asian** works across
   media, and deserves a look for any Chinese, Japanese or Korean content. A dashboard prototype is Web (it is a
   product screen); a data page inside a deck is Slides (it turns).
2. **Look before you read.** Each section has an overview sheet beside this file, `assets/sheets/<section>.jpg`
   (`web`, `ppt`, `info`, `app`, `east`, `xhs`): open it with `read`. The tiles carry the same numbers as the entries
   below, with upstream's Chinese captions. The words say what a style is; the tile shows what done well looks like.
   Subjects and numbers in the tiles are invented: borrow the layout and the temperament, never the content.
3. **Temperature.** Each entry is *bold*, *neutral* or *quiet*. The catalogue leans bold on purpose: a model left alone
   drifts to quiet minimalism.
4. **Fit in plain HTML.** The percentage says how much of the style HTML and CSS carry without generated images. 90 %
   and up: build it. 70 to 90 %: the body works, some details degrade. Under 70 %: say in the delivery which part is a
   flat stand-in, never pretend to the original texture. Entries marked **needs material** fail without real
   illustrations, maps or data: get them, or pick another style.
5. **Hex values and fonts are anchors, not recipes.** Derive the palette from the subject with
   `references/colour-type.md`, and check the pairing against its overused list (that list wins over an entry here).
   All fonts named are open (Google Fonts or similar); never write a paid face.
6. **Tokens.** Where one of the `design-system` skill's systems matches, the entry names it (`systems.ts show <id>`):
   the tokens there, the mechanism here.
7. **Avoid by default** (the person's brand may override): an even GitHub-dark navy (#0D1117) with a generic cyan or
   purple glow (authored darks, below, are fine); a purple gradient for everything; emoji as icons; rounded cards with a
   coloured left border; a signature or watermark on a cover.

---

## Web (20) · `assets/sheets/web.jpg`

### W01 Editorial Brutalism · bold · 98 %
Known from Bloomberg Businessweek's 2010–2014 redesign (Richard Turley). For media, launches, a brand's hero, report
covers, opinion pieces.
- **Mechanism:** a 120 px+ headline pressed straight onto 14 px body text; the size contrast is the design.
- **Cues:** black, white and hyperlink blue (#0000EE), one signal colour (orange-red or terminal green). A Helvetica-like
  grotesque, tight tracking, left-aligned. A modular grid cut by 1 px rules; dense, no breathing room by intent.
- **Build:** CSS Grid modules, borders for the rules, `clamp()` for the giant type; links stay blue and underlined.
- **Fonts:** Inter for Neue Haas Grotesk, Geist Mono for code. **Tokens:** `wired`.
- **Avoid:** softening it with padding and rounded cards; it stops being itself.

### W02 Neo-Brutalism · bold · 95 %
Known from The Verge's 2022 redesign. For media, AI tool directories, event pages, community rankings.
- **Mechanism:** cards with 2–4 px black outlines and hard offset shadows, in clashing saturated blocks.
- **Cues:** electric violet to magenta, bright yellow, near-black, white; no rounding. Geometric sans headlines against
  a serif body. A card feed; hover flips a card's colour.
- **Build:** `border: 3px solid #000`, `box-shadow: 4px 4px 0 #000`, grid or flex feed, `:hover` swaps the background.
- **Fonts:** Space Grotesk with Fraunces. **Tokens:** `neobrutalism`, `theverge`.
- **Avoid:** soft shadows or blur; the shadow must be a solid offset.

### W03 Memphis Maximalism · bold · 72 %
Known from Gucci Vault and the Memphis movement. For concept stores, creative campaigns, Y2K or festive pages.
- **Mechanism:** an anti-grid collage: blocks of different sizes rotated and stacked over each other, like walking
  through a curated room.
- **Cues:** retro red, mustard, royal blue, purple and olive side by side on an aged warm beige; retro serifs mixed with
  display faces; navigation as a playful object.
- **Build:** `transform: rotate()`, absolute stacking, saturated blocks, `mix-blend-mode` to fake grain. The archival
  texture of the original does not survive; the geometric collage does.
- **Fonts:** DM Serif Display, Bungee (display), Space Mono.
- **Avoid:** calling the flat version "aged": say the texture is a stand-in.

### W04 Friendly Geometric Candy · bold · 85 %
Known from Duolingo. For learning products, consumer app pages, gamified products, sign-ups.
- **Mechanism:** raised buttons with a solid bottom shadow that disappears when pressed.
- **Cues:** candy green, duck yellow, sky blue on white; an extra-bold rounded face; big radii; a mascot's spot and
  progress bubbles.
- **Build:** `box-shadow: 0 4px 0` and `:active { transform: translateY(4px) }`; large `border-radius`. Without an
  illustrator, the mascot is a CSS shape (a small loss).
- **Fonts:** Baloo 2 or Nunito. **Tokens:** `duolingo`, `lingo`.
- **Avoid:** an emoji mascot; make a shape or generate one.

### W05 Pure-CSS Art · bold · 80 %
Known from Lynn Fisher (lynnandtonic.com). For personal sites, 404 pages, playful brand pages, a designer's own site.
- **Mechanism:** the illustration is drawn in CSS and changes with the viewport: shapes regroup into another picture
  at each breakpoint.
- **Cues:** two to four flat high-contrast colours, a new palette per breakpoint; a heavy geometric sans; no images.
- **Build:** divs with `border-radius`, `clip-path`, `transform` and `box-shadow`; `@media` moves and resizes them. The
  work is in the idea and in hand-placing each shape.
- **Fonts:** Rubik or Archivo.
- **Avoid:** one static drawing; the change across widths is the point.

### W06 Bold Big-Type Editorial · bold · 88 %
Known from Jacquemus and fashion-magazine posters. For fashion commerce, portfolios, manifestos, course covers.
- **Mechanism:** a headline that fills the screen, wrestling with empty space; text and image split 1:1.
- **Cues:** black and white with one restrained accent (nude pink or true red); a huge display sans or a high-contrast
  serif; luxurious margins; mirrored left-right layouts.
- **Build:** `clamp()` and `vh` for the type, a full-bleed grid; without photography, a solid block holds the image's
  place (the layout still stands).
- **Fonts:** Archivo Expanded or Anton, with Playfair Display. **Tokens:** `bold`, `nike`.
- **Avoid:** shrinking the headline to fit a second message.

### W07 Cosmic Retro-Futurism · bold · 75 %
Known from Perplexity's Comet launch site (black, blue, cream; *2001* mood). For AI launches, tech manifestos,
countdowns.
- **Mechanism:** an old astronomical atlas: thin orbit lines and planet dots on cream, set in a classical serif.
- **Cues:** near-black, cream paper (#F0EAD8), one cobalt-to-peacock blue; low saturation; high-contrast serif with
  generous space; black type on cream.
- **Build:** SVG paths for orbits, positioned dots, three colour variables. The full-screen cinematic transition of the
  original becomes scroll parallax and a slowly turning orbit.
- **Fonts:** Cormorant Garamond or EB Garamond, with Space Mono.
- **Avoid:** neon or glow; the look is printed, not lit.

### W08 Cinematic Sound-Viz Dark · bold · 72 %
Known from ElevenLabs and Saul Bass title sequences. For audio and voice AI, music tech, podcasts.
- **Mechanism:** a waveform running through a dark full-bleed page, a huge title pressed onto it.
- **Cues:** pure black, white type, one blue-to-violet gradient for the waveform; big minimal sans; feature cards below.
- **Build:** an SVG polyline or a row of bars of different heights, animated with CSS. A waveform that follows real
  sound (Web Audio, canvas) is out of reach for plain CSS: the static version looks right, the live one does not.
- **Fonts:** Inter or Sora. **Tokens:** `elevenlabs`.
- **Avoid:** fake "live" claims for a decorative loop.

### W09 Pixel-Game Side-Scroller · bold · 70 %
Known from Robby Leonardi's interactive résumé (an SNES platformer). For creative résumés, playful campaigns, easter
eggs.
- **Mechanism:** the page is a game: scroll moves you through levels, each with its own cartoon palette.
- **Cues:** forest green and sky blue, then space purple, volcano orange, sea teal; a pixel font; parallax layers; a
  game HUD.
- **Build:** layered `position` with scroll offsets, `image-rendering: pixelated`, sprite steps with
  `background-position`. Original pixel art is the gap: square-built icons stand in (the art degrades, the technique
  does not).
- **Fonts:** Press Start 2P or VT323, with Inter. **Tokens:** `pacman`.
- **Avoid:** pixel type for body text; keep it for headings and the HUD.

### W10 Bauhaus Geometric · neutral · 90 %
Known from Khan Academy's rebrand and Bauhaus composition. For courses, logo systems, infographics, children's
products, event visuals.
- **Mechanism:** every illustration is built from circles, triangles and squares on a grid.
- **Cues:** primary red, yellow and blue with black and white, flat fills; a rounded geometric sans; modular,
  jigsaw-like layouts.
- **Build:** `border-radius: 50%`, `clip-path` triangles, square divs, inline SVG; no assets needed.
- **Fonts:** Poppins or Manrope.
- **Avoid:** gradients or shading on the shapes.

### W11 Dark Editorial Portfolio · neutral · 96 %
Known from Brittany Chiang's portfolio (v4). For portfolios, developer products, résumés, AI tool pages.
- **Mechanism:** a fixed left sidebar with anchors and a scrolling main column, with one fluorescent accent.
- **Cues:** deep navy (#0A192F), slate text, one mint accent (#64FFDA); a sans body with monospace numbers and labels;
  underlines that slide in on hover.
- **Build:** `position: sticky` sidebar, a two-column grid, one accent variable.
- **Fonts:** Inter with JetBrains Mono.
- **Avoid:** the numbered section labels and mono kickers everywhere; the layout check calls them template decoration.

### W12 Warm Editorial · neutral · 97 %
Known from Anthropic and Claude, and Penguin paperbacks. For AI products, brand sites, long reading, ebooks, reports,
training.
- **Mechanism:** a book's reading rhythm on screen: one comfortable column, a serif display over a sans body.
- **Cues:** cream paper (#F5F0E8), terracotta (#D97757), near-black text; quiet dividers; line height about 1.7.
- **Build:** colour variables, two font stacks, `max-width` on the column.
- **Fonts:** Fraunces or Newsreader, with Inter. **Tokens:** `claude`, `warm-editorial`.
- **Avoid:** sliding into it. It is the look models fall into unasked (Claude's own palette): choose it on purpose,
  never for all three drafts, and not when the look ledger shows it recently.

### W13 Glass Bento · neutral · 85 %
Known from Linear and Cursor ("the Linear look"). For SaaS and AI products, developer tools, product feature pages.
- **Mechanism:** a dark bento grid with hairline dividers, glowing gradient edges and frosted glass.
- **Cues:** near-black (#08090A), desaturated indigo (#5E6AD2), a faint cyan-to-violet glow; a geometric sans with
  negative tracking.
- **Build:** `radial-gradient` and blur for glow, `backdrop-filter: blur()`, gradient borders, a grid for the bento.
  Real product screenshots are the gap: a simplified UI from blocks and text stands in.
- **Fonts:** Inter or Geist, with Geist Mono. **Tokens:** `linear-app`, `cursor`, `glassmorphism`, `bento`.
- **Avoid:** glow on every card; the layout check flags glows.

### W14 Angled Fluid Gradient · neutral · 92 %
Known from Stripe's angled gradient band. For SaaS and fintech pages, brand heroes, launches.
- **Mechanism:** a skewed band of flowing multi-colour gradient, with a rational grid of content under it.
- **Cues:** indigo (#635BFF) through cyan, pink and orange in the hero; white content area, near-black text; a refined
  sans.
- **Build:** `skewY()` or `clip-path: polygon()` for the angle, layered `linear-gradient` (slowly animated if you like).
  Mark the gradient `data-allow-gradient` so the layout check knows it is meant.
- **Fonts:** Inter or Hanken Grotesk. **Tokens:** `stripe`.
- **Avoid:** gradients beyond the band.

### W15 Utility-First Colourful Docs · neutral · 98 %
Known from the Tailwind CSS docs. For technical docs, API references, design-system sites, help centres.
- **Mechanism:** three columns (navigation, text, contents) with a rainbow of category colours to find your way.
- **Cues:** sky blue brand, a teal-to-sky hero, slate greys; category hues (pink, purple, green, orange); clean sans and
  highlighted code.
- **Build:** a three-column grid, category variables, `span`-coloured code; a little JS for copy and dark mode.
- **Fonts:** Inter with JetBrains Mono or Fira Code.
- **Avoid:** colouring by decoration; each hue names one category.

### W16 Terminal-Core Soft-Futurism · neutral · 80 %
Known from Cursor, and Teenage Engineering's industrial minimalism. For AI coding tools, CLI products, developer
infrastructure.
- **Mechanism:** monospace type is the hero, as a command line, beside 2.5D isometric cubes.
- **Cues:** charcoal (#0B0D14), warm white text (#F2F0EF), a restrained blue-violet glow on buttons; bento sections.
- **Build:** mono code blocks, dark bento, soft glow; isometric cubes from CSS 3D transforms or an SVG projection. A
  clickable multi-screen demo needs JS and a fake UI.
- **Fonts:** Geist Mono or JetBrains Mono, with Inter. **Tokens:** `cursor`, `warp`.
- **Avoid:** #0D1117 navy with a neon glow (the default no-go above).

### W17 Functional Brutalism · quiet · 98 %
Known from Are.na, Lobsters and Quartz; Müller-Brockmann's grid, Tufte's density. For communities, aggregators,
knowledge bases, mobile-first feeds.
- **Mechanism:** dense lists separated by grey hairlines, in the system font, with blue links.
- **Cues:** near-white (#FBFBFB), black text, 1 px grey rules (#E0E0E0), link blue and visited purple; small margins,
  tight leading.
- **Build:** `border-bottom: 1px` lists, the `system-ui` stack, compact padding. Nearly no assets or JS.
- **Fonts:** system-ui, or IBM Plex Sans.
- **Avoid:** tap targets under 40 px on a phone; dense is not small.

### W18 Gallery Dark · quiet · 75 %
Known from Glass (glass.photo) and Bottega Veneta. For photography, luxury commerce, immersive visual work.
- **Mechanism:** a darkroom: one centred column of large images framed by huge black margins, with EXIF-like captions.
- **Cues:** pure black (#0A0A0A), the work supplying all colour, faint grey captions (#666); a very light sans.
- **Build:** black ground, a centred `max-width` column, large padding, small metadata. **Needs material:** real
  photographs; without them the soul is gone, though the frame works.
- **Fonts:** Inter (300) or Cormorant. **Tokens:** `luxury`.
- **Avoid:** captions under 12 px or under 4.5:1 contrast; faint is not illegible.

### W19 Swiss Monochrome · quiet · 98 %
Known from Vercel and the Next.js docs; Vignelli's less is more. For developer docs, technical brands, AI products,
minimal reports.
- **Mechanism:** pure black and white, sharp corners and a precise grid; at most one blue link.
- **Cues:** #000, #FFF and greys; Geist and Geist Mono; no or tiny radii; hairline borders; triangle and arrow marks.
- **Build:** grid, two colour variables, `border-radius: 0`. Geist is open source.
- **Fonts:** Geist and Geist Mono. **Tokens:** `vercel`.
- **Avoid:** adding a brand colour "to warm it up"; the restraint is the style.

### W20 White Gallery (Kenya Hara) · quiet · 80 %
Known from Cosmos (cosmos.so) and Aesop; Kenya Hara's *White*. For premium commerce, galleries, curation, moodboards.
- **Mechanism:** a white box: a masonry grid in luxurious white space, the UI receding behind the content.
- **Cues:** near-white (#FAFAFA), black text, faint grey dividers (#EFEFEF); small sans with wide tracking.
- **Build:** CSS columns or grid for masonry, large padding. The smooth inertial scroll and image entrances carry much
  of the luxury (Lenis or GSAP); plain CSS transitions are a lesser version.
- **Fonts:** Inter (light) or Cooper Hewitt. **Tokens:** `minimal`, `spacious`.
- **Avoid:** white space with no anchor: the page must read as composed, not as failed to load.

---

## Slides (20) · `assets/sheets/ppt.jpg`

### P01 Neo-Swiss Billboard · bold · 98 %
Known from big-number AI and SaaS funding decks, Businessweek graphics, Pentagram. For pitches, business reviews, trend
recaps, launch key pages.
- **Mechanism:** billboard type: a number takes half the slide (about 3× the headline), a short note beside it.
- **Cues:** white or near-black ground, one saturated accent (electric blue, fluorescent green or brand orange), grey
  grid lines; a heavy sans with tabular figures; four masters: one-word section slide on a colour block, giant number,
  split comparison, full flat chart.
- **Build:** `clamp()` numbers, a strict grid, charts in divs or inline SVG, `font-variant-numeric: tabular-nums`.
- **Fonts:** Inter or Geist, Geist Mono for figures.
- **Avoid:** two big numbers on one slide.

### P02 Black Big-Number Stage · bold · 97 %
Known from Steve Jobs' 2007 iPhone keynote, Xiaomi launches, Spotify Wrapped, *Presentation Zen*. For keynotes, talks,
town halls, emotional year reviews.
- **Mechanism:** one word or one number per black slide, lit by a single brand colour.
- **Cues:** pure black, white type, one accent per slide (orange, green or blue); a heavy geometric sans, tight
  tracking; lots of empty space; a two-column spec comparison with the accent against grey.
- **Build:** black and white in a few lines of CSS, `clamp()` and flex centring, the accent in its own span.
- **Fonts:** Geist, Inter, or Source Han Sans for CJK. **Tokens:** `dramatic`.
- **Avoid:** product photos as filler; text alone is closer to the original idea.

### P03 Mono-Brand Type-as-Hero · bold · 96 %
Known from Spotify Wrapped, Mailchimp's brand book (Collins), Netflix. For brand and marketing strategy, campaigns,
culture slides, event key visuals.
- **Mechanism:** one brand colour floods the slide, and the type is the picture.
- **Cues:** a single brand colour full bleed with black or white type; two-colour splits; type from edge to edge.
- **Build:** a full background, `font-weight: 900`, negative tracking, two 100 % blocks for splits.
- **Fonts:** Inter, Manrope or Archivo (extra bold). **Tokens:** `spotify`.
- **Avoid:** a third colour.

### P04 Full-Bleed Gradient Manifesto · bold · 82 %
Known from Zuora's "Tell a different story" sales deck, Nike's "Just Do It", National Geographic spreads. For vision
slides, brand manifestos, keynote turns, mission pages.
- **Mechanism:** a full-bleed field of colour with one reversed slogan across it, and a hashtag line.
- **Cues:** CSS gradients (warm orange to magenta, deep blue to cyan) or a solid bleed; heavy uppercase sans; a promised
  land slide; a customer logo wall.
- **Build:** `linear-` or `radial-gradient` full bleed (gradients are allowed here, particles are not); logos as grey
  SVG or words. Documentary photography in the original becomes the gradient: about 15 % lost.
- **Fonts:** Archivo, Anton or Manrope (extra bold).
- **Avoid:** a gradient on every slide; it marks the turn, not the deck.

### P05 Candy-Colour Lecture Stage · bold · 94 %
Known from Harvard's CS50 (David Malan), the Lessig and Takahashi methods. For courses, technical talks, explaining a
concept, teaching code.
- **Mechanism:** one concept per slide: one huge word in a candy colour floating on black.
- **Cues:** near-black ground; magenta, cyan, yellow and green taking turns; very little text; monospace code with
  syntax colour; a faint spotlight vignette.
- **Build:** `clamp()` type centred, `pre` with coloured spans, a faint `radial-gradient` vignette.
- **Fonts:** Inter (extra bold), JetBrains Mono.
- **Avoid:** more than one colour per slide.

### P06 Playful Collins Editorial · bold · 75 %
Known from Mailchimp's brand book (Collins, 2018), New Yorker cartoons, Cooper's round serif. For brand decks with an
attitude, agency proposals, culture town halls.
- **Mechanism:** a loud yellow field with a round, playful serif and magazine-style uneven white space.
- **Cues:** Cavendish yellow (#FFE01B), black and a few clashes; Cooper-like round serif headlines; asymmetric layout;
  odd, witty copy.
- **Build:** yellow ground, an asymmetric grid, rotated text blocks. The hand-drawn illustration at its heart needs an
  illustrator or generated images: without them, geometric blocks stand in, about 20 % lost.
- **Fonts:** Fraunces (soft) or Bree Serif, with Inter.
- **Avoid:** emoji in place of the illustrations.

### P07 Irreverent Pop · bold · 80 %
Known from Reddit's ads sales deck, David Carson's type, 90s web, Memphis. For Gen Z brands, meme-led marketing, creator
pitches.
- **Mechanism:** grid-breaking mixed type and meme copy, with a "fun, then facts" turn into serious data.
- **Cues:** Reddit orange-red (#FF4500) and clashes, 90s web colours; thick black borders and hard shadows; spoken-word
  headlines.
- **Build:** rotation, overlap, mixed sizes; `border` and shadow with no blur. Custom meme art becomes geometric
  collage.
- **Fonts:** Archivo or Space Grotesk, with Inter for contrast.
- **Avoid:** breaking the grid on the data slides; that is where it turns serious.

### P08 Y2K Inflated Wrapped · bold · 78 %
Known from Spotify Wrapped (2022–2025), Memphis and Y2K maximalism. For year reviews, personal data cards, shareable
vertical cards.
- **Mechanism:** a giant puffed-up 3D year or number on a clashing full-bleed field.
- **Cues:** magenta, cyan, orange; a Spotify-green spark; duotone portrait gradients; metallic numbers; vertical story
  cards.
- **Build:** stacked `text-shadow` and perspective (or SVG strokes) for the puff; `mix-blend-mode` duotone over grey
  blocks; metal becomes `background-clip: text` gradients, about 15 % lost.
- **Fonts:** Archivo Black or Anton, Clash Display for figures.
- **Avoid:** long text; it is a poster per slide.

### P09 Bento Grid · neutral · 95 %
Known from Apple's keynote bento era, recent consulting decks, Stripe's annual metrics. For feature summaries, QBRs,
sales results, metric pages.
- **Mechanism:** cards of different heights in one grid, one insight per card.
- **Cues:** light grey or cream (#F5F5F7) or near-black ground, brand colour and one or two accents; rounded cards with
  hairline borders or faint shadows; a large display title; tabular KPIs; sparklines and line icons.
- **Build:** `grid-template-areas`, `border-radius`, a 1 px border, inline SVG sparklines.
- **Fonts:** Inter or Geist, Geist Mono for numbers. **Tokens:** `bento`.
- **Avoid:** cards inside cards, and more than six cards on a slide.

### P10 Dark Hairline Terminal · neutral · 94 %
Known from Linear's pitch deck, Vercel's language, CS50's stage. For developer tools, technical pitches, engineering
reviews.
- **Mechanism:** a near-black slide cut by 1 px hairlines, with monospace labels and one violet-blue accent.
- **Cues:** #0D0D0F to #111113 (neutral, not navy), hairlines (#262629), accent #5B5BD6; Inter Tight titles; mono labels;
  extreme white space.
- **Build:** 1 px borders as the grid, a mono font family, faint highlight borders instead of glow.
- **Fonts:** Inter Tight with JetBrains Mono or IBM Plex Mono. **Tokens:** `linear-app`.
- **Avoid:** #0D1117 navy and cyber neon.

### P11 Two-Font Consulting · neutral · 90 %
Known from McKinsey's 2019 identity (Wolff Olins; Bower serif with a sans), BCG Executive Perspectives. For consulting
reports, executive briefings, research, authoritative proposals.
- **Mechanism:** a characterful serif against a plain sans, and an action title that states the conclusion top left.
- **Cues:** deep navy (#051C2C) and white with one brand highlight (a green); warm grey ground; thin blue line patterns;
  magazine-like split of conclusion and visual; big data-point cards.
- **Build:** two font families; patterns with `repeating-linear-gradient` or SVG lines; photos optional.
- **Fonts:** Playfair Display or Fraunces with Inter.
- **Avoid:** titles that are topics ("Market overview"); each title is a sentence that concludes.

### P12 Diagram-Driven Isotype · neutral · 88 %
Known from Salesforce sales decks, Otto Neurath's Isotype, Zelazny's *Say It With Charts*, Gapminder. For platform and
architecture walkthroughs, customer journeys, methods, ecosystem maps.
- **Mechanism:** the story is told by diagrams: arrow flows, layered architecture boxes, icon grids, 2×2s, waterfalls.
- **Cues:** corporate blue blocks with a colour per product line; a clear sans; one stroke weight for all icons.
- **Build:** flex arrows with `clip-path` heads or SVG; nested bordered divs; inline SVG icons; grid waterfalls.
- **Fonts:** Inter or IBM Plex Sans.
- **Avoid:** icons of mixed styles; draw one set.

### P13 Diagrammatic Minimalism · neutral · 95 %
Known from Simon Sinek's Golden Circle, Bauhaus abstraction. For frameworks, TED-style ideas, models and methods, a
one-concept keynote.
- **Mechanism:** one geometric mother diagram (concentric circles, a triangle, a matrix) carries the whole idea.
- **Cues:** white or light ground, black, one accent; flat geometry; uppercase labels set into the shapes; arrows from
  the centre out.
- **Build:** nested circles or SVG, `clip-path` triangles, SVG markers, absolutely placed labels.
- **Fonts:** Manrope, or Jost for Futura.
- **Avoid:** a second diagram; reuse the first and highlight a part.

### P14 Narrative Sparkline · neutral · 91 %
Known from Nancy Duarte's *Resonate* sparkline, *An Inconvenient Truth*. For talk structure, change stories,
before-and-after, data story arcs.
- **Mechanism:** a wave line across the whole slide, annotated at its turns, the turning points in one orange.
- **Cues:** dark or white ground, brand orange for turns, grey for comparison; stacked comparison waves; a single data
  line alone on black; step-by-step reveal; a curve climbing out of the frame.
- **Build:** smooth SVG paths, circles and text for annotations, `stroke-dashoffset` reveals.
- **Fonts:** Inter, Geist Mono for figures.
- **Avoid:** axes and gridlines; the curve is a story, not a chart.

### P15 Assertion-Evidence (Tufte) · quiet · 93 %
Known from Michael Alley's assertion-evidence method, consulting action titles, Tufte's data-ink, Minto's pyramid. For
academic and engineering reviews, rigorous consulting pages, policy research.
- **Mechanism:** a full-sentence title over one piece of visual evidence; no bullets.
- **Cues:** white or near-white, black text, one restrained accent (deep blue or brick red); labels written into the
  chart; no chartjunk.
- **Build:** minimal SVG or CSS charts with no gridlines or legends, labels placed at the data.
- **Fonts:** Source Serif or Lora titles, Inter body.
- **Avoid:** a noun phrase as the title.

### P16 Institutional Swiss Minimal · quiet · 96 %
Known from Sequoia's 10-slide template, Airbnb's 2009 seed deck, Müller-Brockmann, Vignelli. For investor pitches,
standard proposals, problem-solution stories.
- **Mechanism:** a title band across the top and three parallel columns below; one message per slide.
- **Cues:** white, black and grey text, one brand accent (coral or a neutral blue); a Helvetica-like sans; short
  sentences with large spacing; TAM as nested blocks; a 2×2 competitor matrix.
- **Build:** flex columns, a grid with borders for the matrix, nested divs for TAM.
- **Fonts:** Inter.
- **Avoid:** decoration of any kind.

### P17 Editorial Longform · quiet · 95 %
Known from Stripe's annual letter, Amazon's six-page memo, Benedict Evans, Stripe Press. For annual letters, deep
essays, internal updates, research reading.
- **Mechanism:** a publication read in order: prose paragraphs with inline data cards and huge numbers as anchors.
- **Cues:** off-white (#FBFAF8), deep ink, one brand spark (a violet); serif or a fine sans; a masthead; columns.
- **Build:** `column-count` or grid, inline cards, a 65ch measure.
- **Fonts:** Newsreader or Source Serif, Inter, tabular figures. **Tokens:** `publication`.
- **Avoid:** bullets; this is prose.

### P18 Humanist Rounded Cards · quiet · 80 %
Known from Khan Academy's Wonder Blocks, Source Serif. For learning products, friendly lectures, non-profit decks, warm
proposals.
- **Mechanism:** large rounded cards and a humane serif: kind, a little imperfect.
- **Cues:** forest greens (#14BF96, #0A5C4B) on off-white with warm helpers; Source Serif titles; soft shadows.
- **Build:** big radii and soft shadows, a serif family. Real photography of people is the gap: green geometric blocks
  stand in, about 18 % lost.
- **Fonts:** Source Serif 4 with Nunito Sans or Inter. **Tokens:** `friendly`.
- **Avoid:** emoji people; generate or source a photo.

### P19 Dense Research Report · quiet · 92 %
Known from Mary Meeker's *Internet Trends*, CB Insights' *State of AI*, McKinsey Global Institute, FT and Bloomberg
graphics. For trend reports, industry reviews, market maps.
- **Mechanism:** a conclusion sentence over one full-page chart, with a source footnote; almost no white space.
- **Cues:** white, one brand blue in steps for the highlight, everything else grey; logo-grid market maps; KPI cards.
- **Build:** all charts in CSS or inline SVG; logos as text or SVG cells.
- **Fonts:** Inter, IBM Plex Sans, tabular Geist Mono.
- **Avoid:** footnotes under 12 px.

### P20 All-Text Manifesto · quiet · 97 %
Known from Netflix's 2009 culture deck and Amazon's narrative memo. For culture and values, deep memos, anti-slide
documents.
- **Mechanism:** one claim per slide, all text: no images, no bullets, one colour for the key phrase.
- **Cues:** pure white or black, one accent (Netflix red); reading-grade type; candid spoken paragraphs; named rules
  highlighted; an appendix table.
- **Build:** `clamp()` headlines left-aligned, a measured prose column, one highlight span.
- **Fonts:** Newsreader or Source Serif (reading), or Inter (manifesto); Archivo for heavy titles.
- **Avoid:** illustrating it; the absence of pictures is the statement.

---

## Infographics (20) · `assets/sheets/info.jpg`

One image, or a set, where data is the hero and reads without interaction.

### I01 Personal Annual Report (Feltron) · bold · 94 %
Known from Nicholas Felton's annual reports (2005–2014, several in MoMA's collection), Stefanie Posavec. For personal or
team year reviews, quantified self, product year recaps.
- **Mechanism:** private trivia set like a corporate annual report: a modular print grid of big numbers.
- **Cues:** uncoated warm white, one vermilion through everything, slate blue for a second series, a third colour bound
  to one meaning only; a tight grotesque, huge numbers, dense small notes; four modules: a number strip, a polar cycle
  (24 h or 12 months), a calendar heat grid, a band of time or place across the page; 1 px rules; still readable in
  black and white.
- **Build:** grid modules and 1 px borders; polar charts in inline SVG with angles you compute (no chart library).
- **Fonts:** Archivo or Helvetica Neue for numbers, Inter for notes.
- **Avoid:** reusing the third colour for anything else.

### I02 Explanation Graphics (Nigel Holmes) · bold · 76 %
Known from Nigel Holmes at TIME (1978–1994). For explaining science and concepts to lay readers, columns, children.
- **Mechanism:** the chart is drawn as the thing itself: banknotes stacked into bars, a thermometer as the scale, a
  running track as progress; with humour and little figures.
- **Cues:** three or four saturated flat colours with black outlines; a round sans with handwritten notes; no gradients.
- **Build:** the chart skeleton in CSS or SVG. **Needs material:** the drawings are its soul; in plain HTML they become
  geometric blocks (say so), or generate the elements with `image_generate` and compose them.
- **Fonts:** Nunito or Baloo 2, with Caveat for notes.
- **Avoid:** a joke that distorts the numbers; the picture still has to measure right.

### I03 Cross-Section Epic (Adolfo Arranz) · bold · 55 %
Known from Adolfo Arranz at the South China Morning Post (Malofiej golds; *City of Anarchy*, Kowloon Walled City). For
anatomy of buildings, history and objects, one image read for ten minutes, museum-grade explainers.
- **Mechanism:** one huge cutaway in isometric or straight section, ringed by dense leader-line callouts.
- **Cues:** a dark ground (deep ink or brown), warm highlights, aged paper.
- **Build:** **needs material:** plain HTML cannot draw the hand-made section; HTML carries only the callout layer and
  the zoom and scroll. Without an illustration, pick another style.
- **Fonts:** Source Serif for titles, Inter for callouts.
- **Avoid:** faking the drawing with a few shapes.

### I04 Magazine Pop Data (Businessweek) · bold · 90 %
Known from Businessweek under Turley, WIRED chart pages, The Economist's Graphic Detail. For business and tech charts,
opinion columns, square social images, charts inside articles.
- **Mechanism:** the chart is the layout; one argument per image, with a title that states the conclusion.
- **Cues:** two clashing colours (fluorescent yellow and black, or magenta and navy) and paper white, never a third;
  extra-bold condensed titles against tiny captions (10× the size); charts bleeding past the margin.
- **Build:** inline SVG or grid bars; negative margins for the bleed.
- **Fonts:** Archivo Black or Anton, with IBM Plex Sans.
- **Avoid:** a neutral title ("Revenue 2020–2025").

### I05 Isotype (Neurath and Arntz) · bold · 88 %
Known from Otto Neurath and Gerd Arntz's picture statistics (Vienna, 1920s). For population and social data, public
communication for every reader, educational posters.
- **Mechanism:** one icon repeated N times stands for a quantity. Enlarging an icon to mean more is wrong: the rule
  the whole system rests on.
- **Cues:** a few flat inks (black, red, blue, ochre), no gradients or shadows; silhouette rows, labels on the left;
  strong order.
- **Build:** inline SVG silhouettes repeated in a row; draw your own geometric figures.
- **Fonts:** Jost or Archivo (for Futura).
- **Avoid:** fractional icons without a stated rule for them.

### I06 Data Humanism (Giorgia Lupi) · bold · 80 %
Known from Giorgia Lupi (Pentagram) and Stefanie Posavec's *Dear Data*. For personal and emotional data, small samples
described deeply, many dimensions that are not numbers.
- **Mechanism:** a custom visual language (size, shape, spikes, tails each encode a field) with a legend that teaches
  the reader to decode it; elements on organic paths, no grid.
- **Cues:** a journal off-white and four or five soft colours (coral, pine, mustard, ink purple), each bound to a
  meaning; no colour is decoration.
- **Build:** parametric inline SVG (radius, spike count, tail length from the data), Bézier paths through the points.
  Only the real hand-drawn stroke is out of reach.
- **Fonts:** Georgia or Source Serif for titles, Inter for the legend.
- **Avoid:** leaving out the legend.

### I07 Scrollytelling (The Pudding) · bold · 85 %
Known from The Pudding, NYT's The Upshot, Reuters Graphics. For arguments revealed step by step, long data stories,
web features.
- **Mechanism:** text steps on one side, a graphic on the other that morphs with scroll; each screen moves one
  variable; the end shows the whole.
- **Cues:** colour changes by chapter with one accent throughout; the graphic is never swapped, only transformed.
- **Build:** IntersectionObserver states, CSS transitions or SVG attribute tweens. It must ship as a page: a PDF or PNG
  loses the whole story, so never pick it for a static image.
- **Fonts:** Inter or Source Serif.
- **Avoid:** hiding the content until the observer fires; show it by default and animate from there.

### I08 Cartographic Lead (Stamen) · bold · 65 %
Known from Stamen Design's watercolour and toner maps. For geographic distributions, cities, transport, environment.
- **Mechanism:** the map fills the page and sets the tone; data sits on it as dots or flows; the legend is tiny in a
  corner.
- **Cues:** an authored base map (watercolour or one-colour toner), a high-contrast data layer.
- **Build:** **needs material:** real geodata (GeoJSON) and a base map; with data, project it in inline SVG. Never draw a
  fake map by hand.
- **Fonts:** Inter or IBM Plex Sans (many small labels).
- **Avoid:** a map without a source line.

### I09 Newsroom Chart System (FT) · neutral · 96 %
Known from the Financial Times' Chart Doctor and its Visual Vocabulary (deviation, correlation, ranking, distribution,
change over time, part to whole, magnitude, spatial). For financial and industry data, a series of charts under one
standard.
- **Mechanism:** choose the chart by the data's relationship first, then style it: title as conclusion, subtitle with
  units and scope, a chart with no frame or grid, the source bottom left.
- **Cues:** the salmon newspaper ground; ordered colour ramps (one hue for continuous values, two for deviation);
  minimal axes.
- **Build:** CSS or SVG lines and bars.
- **Fonts:** Inter or Source Sans, with a monospace for figures.
- **Avoid:** dropping the source line.

### I10 Computational Portrait (Fathom) · neutral · 78 %
Known from Ben Fry and Fathom Information Design (Processing, *Visualizing Data*). For very large datasets, genomes,
traffic, long time series.
- **Mechanism:** show everything, not a summary: thousands of hairlines overlap until density draws the shape.
- **Cues:** white or near-black, very fine lines, one colour stacked by transparency; no decoration.
- **Build:** canvas or many SVG paths drawn by code (canvas when the data is large). **Needs material:** the real, full
  dataset; a small sample cannot make the density.
- **Fonts:** Inter or Roboto Mono.
- **Avoid:** invented data; the shape must come from the data.

### I11 Beautiful Information (McCandless) · neutral · 90 %
Known from David McCandless' *Information is Beautiful*. For popular comparisons, rankings, social charts.
- **Mechanism:** area is quantity: bubbles, treemaps and Sankeys with labels set on the shapes; dozens of items in one
  view.
- **Cues:** many colours of the same lightness and chroma (a harmonious wheel, not random clashes); legends inside.
- **Build:** grid or SVG layouts with a small packing algorithm you write; Sankey ribbons as SVG Béziers.
- **Fonts:** Nunito Sans or Inter.
- **Avoid:** radius instead of area for bubbles.

### I12 Open Research Data (Our World in Data) · neutral · 94 %
Known from Our World in Data (Oxford). For serious topics, data that must withstand challenge, long trends.
- **Mechanism:** labels at the ends of the lines instead of a legend; what is not the point is grey.
- **Cues:** white, distinct but calm category colours, grey for other series; a one-sentence conclusion title; scope and
  years in the subtitle; source and licence at the bottom.
- **Build:** SVG lines with positioned end labels.
- **Fonts:** Inter or Lato.
- **Avoid:** a legend box; label the lines.

### I13 Speculative Tech Diagram (Takram) · neutral · 84 %
Known from Takram (Tokyo and London). For technology concepts, future scenarios, white papers, product architecture.
- **Mechanism:** a diagram laid out like an installation: precise geometry in much white space.
- **Cues:** sand-grey ground, muted natural colours (moss, terracotta) and one metallic grey; thin weights, wide
  tracking, careful mixed scripts; 0.5–1 px lines.
- **Build:** CSS and SVG; restraint in margins and line weight is the whole craft.
- **Fonts:** Inter (light) or Noto Sans JP, Cormorant for titles.
- **Avoid:** heavy strokes or saturated colours.

### I14 Pictogram System (Otl Aicher) · neutral · 92 %
Known from Otl Aicher's pictograms for Munich 1972 and the Ulm grid. For flows, wayfinding and guides, multilingual
use, any set of icons that must agree.
- **Mechanism:** every icon on the same grid with strokes only at 0, 45 and 90 degrees, each paired with a short label.
- **Cues:** a limited palette (Munich: light blue, green, silver) and black; a sans for labels; the grid visible.
- **Build:** inline SVG drawn under the 45° rule, a CSS grid.
- **Fonts:** Jost or Archivo (for Univers).
- **Avoid:** one icon from a different set.

### I15 Small Multiples (Tufte) · quiet · 95 %
Known from Edward Tufte's small multiples and sparklines. For comparing many slices, grouped time series.
- **Mechanism:** the same small chart repeated with different data and **one shared axis range**: different ranges
  destroy the comparison, the one fatal mistake here.
- **Cues:** white, black lines, one accent for the outlier; tiny labels beside each; no legend, no gridlines.
- **Build:** a grid of inline SVG lines with one domain for all.
- **Fonts:** Source Serif for titles, Inter for labels.
- **Avoid:** per-chart scales.

### I16 Topological Transit Map (Beck, Vignelli) · quiet · 86 %
Known from Harry Beck's London Underground map (1933) and Vignelli's New York subway map (1972). For process and
relationship networks, org charts, system topology.
- **Mechanism:** segments only at 0, 45 and 90 degrees with evenly spaced stations: geography given up for legibility.
- **Cues:** white or light ground, one pure colour per line, hollow circles for interchanges.
- **Build:** inline SVG polylines kept to the angles, circles for stations.
- **Fonts:** Jost or Inter (station names may be uppercase).
- **Avoid:** a free angle anywhere.

### I17 Ma and Emptiness (Kenya Hara) · quiet · 82 %
Known from Kenya Hara's *White* and MUJI. For brand annual reports, slow stories, few but important numbers.
- **Mechanism:** one number per screen in vast white space, placed at an edge or a golden point, never filling.
- **Cues:** white or rice-paper white, faint grey, one tiny point of ink or vermilion; lines almost too thin to see.
- **Build:** plain CSS. The riskiest style here: the space must be composed around a clear anchor, or it reads as a
  broken page; body text stays at 14 px or more.
- **Fonts:** Noto Serif SC or Source Han Serif, with Inter.
- **Avoid:** shrinking text for the mood.

### I18 Bookcraft Data (Irma Boom) · quiet · 80 %
Known from Irma Boom (book designer, MoMA collection). For long data reports, annual reports to be kept, deep mixed
content.
- **Mechanism:** typography is the protagonist: extreme size range, asymmetric margins, text set vertically or turned;
  data woven into the text; chapters split by full colour pages.
- **Cues:** paper and one or two inks pressed over large areas.
- **Build:** CSS columns, `writing-mode` for vertical text, grid for the asymmetric block. Paper and trimming cannot
  come through: the type tension must carry it.
- **Fonts:** Fraunces or EB Garamond, with Archivo.
- **Avoid:** symmetry.

### I19 Scientific Figure Plate · quiet · 96 %
Known from Nature and Science figure rules, USGS and NASA plates. For findings, method comparisons, peer-review rigour,
multi-panel figures.
- **Mechanism:** panels (a), (b), (c), a long caption under the figure, error bars and sample sizes always shown, axes
  with ticks.
- **Cues:** white, colour-blind-safe pairs (blue and orange, not red and green), greys; no decoration.
- **Build:** a grid of SVG panels with error bars, a small caption paragraph.
- **Fonts:** Inter or Source Sans, Roboto Mono for figures.
- **Avoid:** red-green encodings.

### I20 Swiss Grid Report (Müller-Brockmann) · quiet · 97 %
Known from *Grid Systems in Graphic Design*, the Ulm school, Swiss annual reports. For corporate and institutional
reports, document series that keep one layout for years.
- **Mechanism:** a strict modular grid (often 12 columns): every element snaps to a column, ragged right, hierarchy from
  size and space only.
- **Cues:** white, black, one accent; a Helvetica-like sans; never centred.
- **Build:** CSS Grid maps the columns one to one: the style closest to HTML itself.
- **Fonts:** Inter or Archivo.
- **Avoid:** decoration to make up for a weak hierarchy.

---

## App (12) · `assets/sheets/app.jpg`

Each tile is a presentation board: two or three phone screens, the composition itself an example.

### A01 Hardware Panel (Teenage Engineering) · bold · 85 %
Known from Teenage Engineering's OP-1 and EP-133 K.O. II. For audio and creative tools, samplers, metronomes, companion
apps for hardware.
- **Mechanism:** the screen is a device face: a dot-matrix readout, a square key grid, knobs and faders, labels like
  silkscreen print.
- **Cues:** near-black screen (#0B0B0B), signal orange (#FF5A1F) only for what is active, grey-white keys, a light grey
  panel with a fine grid; dot-matrix numbers, uppercase wide-tracked labels; keys with a pressed depth (a 4 px inset
  bottom shadow).
- **Build:** a grid of `aspect-ratio: 1` keys, knobs from `radial-gradient` with a rotated pointer, absolute faders.
- **Fonts:** Doto (readouts), Space Mono (labels), Noto Sans SC for Chinese.
- **Avoid:** orange everywhere; one active thing at a time.

### A02 Liquid Glass (iOS 26) · bold · 70 %
Known from Apple's Liquid Glass (WWDC 2025, iOS 26). For weather, sport and media apps, system-like tools, content-first
screens with floating controls.
- **Mechanism:** content fills the screen and the controls float over it as translucent glass capsules and panels; the
  tab bar is a floating capsule, not a bar.
- **Cues:** colour comes from the content (a saturated gradient: coral to magenta to indigo, or teal to mint); white
  glass with a gradient highlight edge and an inner top highlight; system sans, tight big numbers.
- **Build:** `backdrop-filter: blur(22px) saturate(180%)`, a translucent white gradient, a 1 px white border, an inset
  highlight. The ground must have colour depth, or the glass is a grey block. Refraction and specular light are out of
  reach: say so.
- **Fonts:** Inter (for SF Pro), Noto Sans SC. **Tokens:** `glassmorphism`.
- **Avoid:** glass on a flat colour.

### A03 Playful Tactile (Not Boring) · bold · 70 %
Known from Andy Works' (Not Boring) apps (Habits: Apple Design Award 2022). For timers, habits, weather and calculators,
small tools for younger people.
- **Mechanism:** one big physical object per screen (a dial, a thermometer tube, a switch) with thickness you could
  press; everything else orbits it.
- **Cues:** a saturated full-screen colour per screen (orange, lavender, acid green) with near-black text; fat rounded
  numbers; cards and screens slightly rotated.
- **Build:** stacked `box-shadow` (a solid lower edge, an inner highlight, a soft outer shadow), `radial-gradient`
  highlights, rotation. Haptics and 3D motion become transitions: say so.
- **Fonts:** Bricolage Grotesque (800), Noto Sans SC (900). **Tokens:** `claymorphism`.
- **Avoid:** more than one hero object on a screen.

### A04 Friendly Fintech (Monzo) · bold · 90 %
Known from Monzo (hot coral, deep navy, pill buttons, spoken copy). For budgeting, savings, payments, money for young
people.
- **Mechanism:** a coral top area with the balance and three pill actions; a white panel rises from below like a
  drawer; budgets are "pots" in a two-column grid of big rounded tiles.
- **Cues:** coral (#FF4F40) full width, pastel pot colours; a rounded humanist sans, a balance at 58 px or more;
  radii of 34 px or more; initial-letter icons; plain-spoken headings ("Where your money went").
- **Build:** plain CSS; `border-radius: 28–34px`, a two-column grid, two-layer progress bars.
- **Fonts:** Figtree, Noto Sans SC. **Tokens:** `friendly`.
- **Avoid:** finance jargon in the headings.

### A05 Pro Camera (Halide) · bold · 85 %
Known from Halide (Lux Optics, Apple Design Award). For camera, recording and measuring tools, one-hand adjusting, dark
conditions.
- **Mechanism:** dense scales read at a glance: a parameter row (shutter, ISO, exposure, white balance), a horizontal
  ruler that fades at both ends with one centre line, a shutter key.
- **Cues:** pure black, one yellow (#FFCC00) only for the selected parameter and the centre line (the yellow is this
  entry's choice, not Halide's palette), grey-white readouts; monospace numbers; zebra stripes and a translucent
  histogram.
- **Build:** `repeating-linear-gradient` ticks (short and long layers), `mask-image` fades, 135° stripes for zebras, a
  gradient as the viewfinder's photo slot.
- **Fonts:** JetBrains Mono, Noto Sans SC.
- **Avoid:** yellow in more than three places.

### A06 Topo Outdoor (Gaia GPS, AllTrails) · neutral · 90 %
Known from Gaia GPS' topo maps and AllTrails' route pages. For hiking, cycling, trail and camping tools.
- **Mechanism:** the map is the hero: contour lines and a white-cased track, a bottom panel with three big numbers and an
  elevation profile.
- **Cues:** parchment (#EFEBDA), contour brown (#C09A68, every fifth line heavier), woodland green, water blue, the
  track in orange-red with a white casing; condensed numerals; difficulty colour tags; mini contour thumbnails in lists.
- **Build:** SVG contours (irregular nested closed curves; concentric circles look fake at once), a two-layer track path.
- **Fonts:** Barlow Condensed, Noto Sans SC.
- **Avoid:** regular shapes for terrain.

### A07 Feed Waterfall (Xiaohongshu) · neutral · 92 %
Known from Xiaohongshu's two-column discovery feed. For content communities, recommendations and guides, commerce
feeds, any product where a cover and a title are the way in.
- **Mechanism:** two columns of cards with covers of different heights (1:1 to 3:4), so the feed staggers; a two-line
  title; an author and likes row.
- **Cues:** white cards on light grey (#F5F5F7); brand red (#FF2442) only for the selected tab, the plus button, follow
  and liked states; 6 px gaps, 10 px radii.
- **Build:** two flex columns, covers as gradient slots marked as photo places, `-webkit-line-clamp: 2`, initials for
  avatars (no drawn faces).
- **Fonts:** Noto Sans SC. **Tokens:** `xiaohongshu`, `pinterest`.
- **Avoid:** equal cover heights; the stagger is the feed.

### A08 Command Palette (Raycast) · neutral · 90 %
Known from Raycast. For developer and productivity tools, ops panels, any product where searching is acting.
- **Mechanism:** one input line on top, grouped single-line results below, each with a coloured icon tile, a name, a grey
  subtitle and right-aligned key caps; an action bar fixed at the bottom.
- **Cues:** near-black (#07080A), panel #121315, selected row #202225, hairlines (#242728); small saturated icon tiles;
  levels by tone, not shadow.
- **Build:** flex rows, hairline borders, key caps with a gradient, a darker bottom border and a 2 px shadow; one outer
  shadow only. Raycast is a desktop app: show a desktop panel and its phone adaptation.
- **Fonts:** Inter, JetBrains Mono, Noto Sans SC. **Tokens:** `raycast`.
- **Avoid:** shadows between levels.

### A09 Health Colour-Code (Apple Health, Oura) · neutral · 92 %
Known from Apple's activity rings and Oura's 0–100 scores. For health, sleep and fitness, any dashboard that answers
"how is today".
- **Mechanism:** colour is the conclusion: a big ring or score as the hero, then cards with a status pill beside every
  value and a translucent normal-range band behind trends.
- **Cues:** black (#000), cards #1C1C1E; status colours (blue best, yellow fair, red attention) kept apart from the ring
  colours; scores at 76 px or more; small grey labels.
- **Build:** SVG circles with `stroke-dasharray`, two-layer bars, translucent range rects, pills with a tinted ground.
- **Fonts:** Inter, Noto Sans SC.
- **Avoid:** mixing status and ring colours into a rainbow.

### A10 Native Polish (Things 3) · quiet · 95 %
Known from Things 3 (Cultured Code, two Apple Design Awards). For tasks, notes, calendars, tools used all day.
- **Mechanism:** clean, crisp lists: an indented hairline from the checkbox on, small bold group headings, a task that
  opens into a raised card.
- **Cues:** white, near-black text, one blue (#3478F6) for checks, links and the plus button, a yellow star for Today,
  grey for secondary; a 32 px bold title with tight tracking; rounded-square checkboxes; a round blue plus.
- **Build:** plain CSS; `border: 2px` checkboxes with a 7 px radius, `::after` hairlines with an indent, a two-layer
  shadow for the open card. Motion cannot show in a still: build the structure.
- **Fonts:** Inter (or the system stack), Noto Sans SC.
- **Avoid:** a second accent colour.

### A11 Gentle Encouragement (Gentler Streak, dark variant) · quiet · 80 %
Known from Gentler Streak (Apple Design Award 2024, social impact), whose own screens are bright; this is a dark variant
of its soft, non-judging tone. For fitness, rehab, sleep and mindfulness, habits for people who give up easily.
- **Mechanism:** an activity path from rest to active as a round-capped gradient curve with a white marker; a dot
  calendar where rest days have their own colour and the streak never breaks.
- **Cues:** night-blue gradient (#18213A to #202C4A), cards #26335A; soft mint, lavender and peach; a rounded sans;
  titles as suggestions ("Today suits a walk"), never "72 % done"; 28 px radii.
- **Build:** an SVG path (a dark track and a gradient stroke cut by `stroke-dasharray`), a grid of round dots. The tone
  of the copy is the craft: no red, no exclamation marks, no rankings.
- **Fonts:** Nunito, Noto Sans SC.
- **Avoid:** guilt ("You missed 3 days").

### A12 Editorial Reader (Matter, Readwise Reader) · quiet · 90 %
Known from Matter and Readwise Reader. For read-later, long reading, highlights and notes, article and podcast queues.
- **Mechanism:** a text-only queue (source and time, a serif title, a two-line summary, a thin progress line, no
  thumbnails); a narrow centred reading column; a dark floating toolbar on selection; a highlight lifted into a card.
- **Cues:** warm paper (#FBF8F1), ink (#26221C), one ochre red (#B5532A) for source, progress and settings; highlighter
  yellow; an 18 px serif body at 1.85 line height; small wide-tracked sans labels.
- **Build:** `mark` with `linear-gradient(transparent 12%, yellow 12%, yellow 92%, transparent 92%)` for a real
  highlighter stroke; `white-space: nowrap` on the toolbar.
- **Fonts:** Literata and Noto Serif SC, Inter for labels. **Tokens:** `paper`.
- **Avoid:** thumbnails in the queue.

**The eight app paradigms** (`assets/sheets/paradigm.jpg`): upstream's walk through two years of App Store Awards
finalists, each a principle rather than a style: the world as interface, a signature object, time with a shape, one
semantic colour, content as the interface, AI landing on the object, a character carrying state, access shaping the
form.

---

## East Asian (12) · `assets/sheets/east.jpg`

Across media: sites, decks, posters, covers, infographics; each entry says where it fits. A random pick in
`references/directions.md` draws one here as well as one in the medium's own section. Chinese layout has its own
grammar (vertical lines, the text block, column rules, title slips, the structure of characters): it is not a Western
style with a CJK font swapped in. Hand lettering, aged paper, real photos and the texture of metal type or woodblocks
cannot be made in HTML and CSS: each entry says what stands in. Designers and works are named only where a source was
found; each entry's cues summarise the style's layout language, not one page pixel by pixel.

### E01 Lü Jingren Bookcraft · quiet · 85 %
Known from Lü Jingren, Chinese book designer: *Zhu Xi's Thousand Character Classic* (paper that carries the feel of a
stele rubbing), *China's Memory: Treasures of Five Thousand Years* (honourable mention, Best Book Design from all over
the World, 2009). He treats a book as a system with its text, editing, binding and printing, not a cover. For album and
annual-report spreads, long features, oral history and archives, exhibition catalogues, slow reading; long-read pages on
the web, chapter openers in a deck.
- **Mechanism:** the text block breathes: off centre, raised and pulled to the spine, a small head margin and a very
  large foot; a narrow side-note column at the fore edge; chapter openers with one large character and a title line.
- **Cues:** warm paper (#F4EFE4), deep ink, cinnabar used **once** (a large character or a seal); line height 2 or
  more; tiny folios and running heads; a gradient where the spread folds.
- **Build:** two 560 px pages side by side, a `linear-gradient` gutter shadow, an absolute side-note column, a seal as a
  red square and one character. Fibre, foil, slipcases and turning pages become flat paper and shadow.
- **Fonts:** Noto Serif SC (with its own Latin), Noto Sans SC for small labels. **Tokens:** `kami`.
- **Avoid:** cinnabar in a second place.

### E02 Song Block-Print Leaf · quiet · 80 %
Known from the leaf format of Song-dynasty woodblock books: the frame (double side rules in the Northern Song, thin
black mouths and ear tabs later), ruled columns, the fish-tail marks at the centre fold with title and folio, and red
annotations by collectors. For archives and records, the "original record" page of a report, cultural content pages,
quotation slides.
- **Mechanism:** everything lives inside the ruled frame: vertical columns read right to left, a centre strip with fish
  tails and folio, red notes in the head margin.
- **Cues:** a frame heavy outside and thin inside; thin rules between columns; slightly yellow paper (#EDE0BC) and black
  ink; red marks beside key lines; no ornament.
- **Build:** `writing-mode: vertical-rl`, a div per column in a `row-reverse` flex, `border-left` rules, `clip-path`
  fish tails, `text-emphasis` for the red circles. Uneven ink, stroke weight and worn paper become even ink on pale
  yellow.
- **Fonts:** Noto Serif TC (closest to a Song block face), Noto Serif SC for simplified text.
- **Avoid:** Latin text in the leaf.

### E03 Republic-Era Book Jacket · neutral · 70 %
Known from Lu Xun and Tao Yuanqing's covers (*Wandering*, 1926; *The Grave*; *Dawn Blossoms Plucked at Dusk*); Lu Xun
designed some himself (*Call to Arms*), mostly with type, simple and pale. For book covers laid flat, albums and
anthologies, cultural landing pages, exhibition posters, packaging.
- **Mechanism:** a white title slip pasted on the cover with the title set vertically, inside a thin double-rule border;
  front, spine and back laid out flat.
- **Cues:** low-saturation earth yellow or grey-green paper; three inks (black, a touch of red, the paper); flat
  geometric motifs (mountain, sun, water lines) with hatching; much empty space.
- **Build:** a three-panel flex, double rules from a border and a pseudo-element, SVG polygons for motifs. The
  hand-written title slip becomes LXGW WenKai; aged paper and misregistered inks become flat colour.
- **Fonts:** LXGW WenKai (or Ma Shan Zheng, rougher) for titles, Noto Serif SC for the rest.
- **Avoid:** realistic illustration.

### E04 Shanghai Moderne Deco · bold · 78 %
Known from Shanghai's calendar posters (late Qing to the 1930s; Zheng Mantuo, Hang Zhiying, Xu Yongqing) and the city's
1930s–40s Art Deco. For posters, brand promotions, coffee, tea and food packaging, retro landing pages, calendars.
- **Mechanism:** an advertisement and a calendar in one symmetric Deco frame: a radiating sun fan and stepped towers.
- **Cues:** deep ink green (#17352F), gold (#C9A24A), vermilion (#9E2A1D), cream paper; gold outer and dark inner
  frames; heavy display lettering with a 3D shadow; a calendar block on the right; a red band at the foot with the
  shop's name and address.
- **Build:** SVG fans, rings and stepped blocks, offset `text-shadow`, a seven-column grid calendar. The airbrushed
  portraits of the originals are out of reach (and should not be drawn in SVG): a geometric object, such as a cup,
  stands in for the figure.
- **Fonts:** ZCOOL XiaoWei (display), Noto Serif SC 900, Noto Sans SC (Josefin Sans for Latin with more Deco).
- **Avoid:** drawing a person.

### E05 Experimental Hanzi Poster · bold · 85 %
Known from Chinese designers who build layouts from the structure of characters: Han Jiaying (AGI, work in the V&A) and
Kan Tai-keung (ink and characters; the Bank of China logo from an old coin). For exhibition and event posters, brand
manifestos, deck covers, the key visual of a long feature, course covers.
- **Mechanism:** one character enlarged to half the page and taken apart stroke by stroke; some strokes shifted or
  filled with one saturated colour; a small diagram numbers the strokes to explain the cut.
- **Cues:** black, paper white and one accent (vermilion #E4351E); fine information rules and small type around it; a
  heavy sans title with the key word coloured.
- **Build:** each stroke an SVG rect or path you place (check the stroke count and order first); the diagram reuses the
  paths and lights one. Pick a character of four to six strokes.
- **Fonts:** Noto Sans SC 900, Noto Serif SC for the intro; the big character is built, not typed.
- **Avoid:** a complex character; it turns to mush.

### E06 Hong Kong Street Signs · bold · 80 %
Known from Hong Kong's hand-lettered and neon signs: the square Northern Wei lettering of the 1940s–70s, vertical and
stacked signs, mixed Chinese and English; neon archives have recorded over 400 surviving signs since 2015. For retail,
restaurants, record shops and night markets, posters, promotions, city nightlife features.
- **Mechanism:** signs stacked on a building at night: a vertical sign over another, horizontal ones overlapping, dense
  and big, covering each other.
- **Cues:** a night wall; each sign a saturated flat colour (red, yellow, blue, green; this palette is a summary of
  night scenes, not from a single source) with a cream frame and an outer glow; heavy traditional characters with a
  hard shadow; a small red LED sign; a hand-written blackboard price list; wires across the scene.
- **Build:** absolute placement, `box-shadow` glow, `text-shadow`, `writing-mode: vertical-rl`. Real Northern Wei
  lettering and bent neon tubes become heavy Noto faces.
- **Fonts:** Noto Sans TC 900, Noto Serif TC 900, Archivo Black for English.
- **Avoid:** tidy alignment; the overlap is the street.

### E07 Solar-Term Palette · neutral · 90 %
Known from *Traditional Chinese Colours: The Colour Aesthetics of the Forbidden City* (Guo Hao, Li Jianming: 384 colours
by season, with cards for the 24 solar terms). For hero screens, seasonal and time-based products, deck contents
pages, travel and outdoor content, brand colour pages, infographics with a time axis.
- **Mechanism:** the palette is organised by traditional colour names, and the 24 solar terms are the navigation: 24
  vertical colour bars across the foot of the page, the current term taller and wider and the page's accent.
- **Cues:** each bar labelled with its term and colour name; warm paper and ink for the text; almost no pattern.
- **Build:** a flex of 24 bars, the current one `flex: 1.6` and taller; text dark or light by each bar's lightness. The
  hex values approximate the names (sources differ): take colours from your own subject.
- **Fonts:** Noto Serif SC, Noto Sans SC for navigation.
- **Avoid:** treating the hex values as a standard chart.

### E08 Sugiura Information Mandala · bold · 72 %
Known from Kohei Sugiura (born 1932, Tokyo; Asian cosmology and images, about 5,000 books including some 1,700 covers
for Kodansha's Gendai Shinsho, time-distance maps, the 1980 Mandala exhibition). For infographics, event posters,
annual or cyclical data, science features, overview slides.
- **Mechanism:** a concentric disc at the centre (an outer ring of terms or ticks, a middle ring of coloured sectors, an
  inner ring of moon phases, a red dot at the heart), surrounded by numbered callouts, each tied to a place on the disc.
- **Cues:** a near-black warm ground, gold, vermilion and cream; vertical display titles beside horizontal text; a
  time-distance chart; dense but every part anchored.
- **Build:** a script that generates SVG sectors, ticks and text along the circle; absolute callouts with SVG leader
  lines. Overprinting, special inks and cross-spine layouts become flat colour.
- **Fonts:** Noto Serif SC for titles and ring text, Noto Sans SC for notes.
- **Avoid:** a callout that points at nothing on the disc.

### E09 Ikko Tanaka Geometric · neutral · 90 %
Known from Ikko Tanaka (1930–2002): the *Nihon Buyo* poster (1981, a geisha's hair and face from squares and circles
on a grid), posters for the Seibu Theatre, art direction of Seibu and of MUJI from its founding; influenced by the Rinpa
school. For exhibition, film and performance posters, brand manifestos, deck covers, cultural institutions' heroes.
- **Mechanism:** squares, circles and quarter circles on a grid make one abstract figure; traditional motifs (fan, sun,
  stripes of a curtain) translated into geometry.
- **Cues:** red (#D9381E), black, mustard and a touch of steel blue on rice paper; a vertical heavy Song title; small red
  labels for dates, venue, theme and price; a thin black rule at the foot.
- **Build:** a 560 px square on a 70 px unit, `border-radius` quarters and halves, `repeating-linear-gradient` stripes.
  Screen-print registration and grain become flat colour.
- **Fonts:** Noto Serif SC 900, Noto Sans SC, Zen Kaku Gothic New for Latin.
- **Avoid:** shapes off the unit grid.

### E10 Hattori Playful Offset · bold · 75 %
Known from Kazunari Hattori (born 1964, Tokyo): Kewpie Half ads, art direction of *Ryuko Tsushin*, the Mitsubishi
Ichigokan Museum logo, the Kamekura Yusaku Award (2004); halftone dots replaced by stripes (from the 2007 *Flag*
poster). For posters, covers, event and media brands, weather and lifestyle content that is light but exact.
- **Mechanism:** one huge character filled with two layers of horizontal stripes in different colours, offset a few
  pixels like a misregistered print; the play stays in one place.
- **Cues:** tilted flat blocks (yellow, black, a coral circle), one fat hand-drawn wavy line; a hand-feel title with each
  character at its own height; the information column set plainly.
- **Build:** `background-clip: text` with `repeating-linear-gradient` stripes, a second offset copy; rotated blocks; an
  SVG line with round caps. Pick a simple character (water, mountain, cloud).
- **Fonts:** Noto Sans SC 900, ZCOOL KuaiLe for the playful title.
- **Avoid:** spreading the play over the whole page.

### E11 Sato Minimal Symbol · neutral · 92 %
Known from Kashiwa Sato: UNIQLO's 2006 rebrand (a red square, white bold type and katakana; red and white for the
national flag), the Cup Noodles Museum. His point: a brand needs one strong symbol. For launch pages, product landing
pages, deck covers, splash screens, start-up heroes.
- **Mechanism:** one character or symbol takes half the page on a flat colour; the other half is white and almost bare.
- **Cues:** a flood of red (#E60012); heavy sans titles; a tiny four-colour swatch (red, black, white, blue) hinting at
  the system; data rows split by heavy top rules in three colours; three colours at most on a page.
- **Build:** two columns, the symbol centred in flex; no images, no gradients. Almost nothing degrades: the difficulty is
  restraint.
- **Fonts:** Noto Sans SC 900, Archivo 800–900 for Latin.
- **Avoid:** a fourth colour.

### E12 Japanese Lifestyle Magazine Dense · neutral · 78 %
Known from POPEYE (1976, "Magazine for City Boys") and BRUTUS (1980), both mastheads by art director Seiichi Horiuchi.
For annual-report or data spreads, city and lifestyle content, data slides, guides and lists, infographics.
- **Mechanism:** dense explanatory spreads: a big title underlined with a yellow marker and a route map with numbered
  dots and handwritten red and blue notes on the left; a 3×3 grid of data, a heat map and reading tips on the right.
  (The handwritten notes summarise such spreads; they are not a copy of any issue.)
- **Cues:** white paper, black type; heavy black grid lines with one yellow and one black cell for emphasis; condensed
  Latin for running heads and folios across the spread.
- **Build:** two 600 px pages, a grid for the data, SVG for the map, a 24×7 grid for the heat map. Photo collage and
  halftone become honest colour blocks marked as photo places.
- **Fonts:** Noto Serif SC 900, Noto Sans SC, Long Cang (handwritten notes), Archivo Narrow.
- **Avoid:** empty space; this style is full on purpose.

---

## Carousel (8) · `assets/sheets/xhs.jpg`

A set of 3:4 images (1242 × 1660 px, up to 18) read by swiping, the first one the cover: Xiaohongshu (RED) or an
Instagram carousel. Each tile shows a cover and one inside page of the same post. Size type for 1242 px wide: body
42 px or more, labels 32 px or more, and never smaller when the content changes. Upstream's subject was one real post
about an open bird-sticker set; its stickers are licensed apart from the rest (PolyForm Shield), so in pi-phone's sheet
every sticker is a plain silhouette: borrow the layout, bring your own pictures. Its paper white, ink black and sun
yellow are examples: derive the palette from the person's brand or content.

### X01 Specimen Journal · neutral · 90 %
From natural-history plates and nature-magazine covers. For nature, science and culture notes that need authority and
a magazine feel.
- **Mechanism:** a 300 px high-contrast serif number is the page's hero, the subject pressed under it and breaking out
  of the column.
- **Cues:** dotted paper; a huge Song-style title; two or three "big number and two-line note" side items; inside, a
  numbered list matched by numbered dots on the subject and a scale bar for position.
- **Build:** absolute positioning, CSS counters for the dots, a thin line with two markers for the scale.
- **Fonts:** Noto Serif SC 900, Bodoni Moda (only above 100 px), Noto Sans SC.
- **Avoid:** Bodoni at body size.

### X02 Product Notebook · neutral · 95 %
From the product's own interface and Xiaohongshu's journal collages. For your own product, app or brand, recognisable at
a glance; friendly, collectable.
- **Mechanism:** the app's own paper and controls become the page: black pills as labels and step numbers, a 2×3 grid of
  named items, a slightly rotated white card held by translucent tape carrying the title.
- **Cues:** inside, a white "review sheet" card: check rows, a ring score, two number cards.
- **Build:** absolute cards with a warm brown `drop-shadow`; tape as a translucent block.
- **Fonts:** Figtree 900, Noto Sans SC 700/900.
- **Avoid:** a product it does not show; it only works with the real interface.

### X03 Index Ink · bold · 95 %
From Swiss index pages and data annual reports. For one numeric finding, rankings, lists, comparisons; a cover that
catches the eye far away in a feed.
- **Mechanism:** a cover on ink black with one 340 px yellow number on top and a 5×3 hairline grid of small pictures
  below.
- **Cues:** inside on paper, a giant black number and a two-line title, numbered table rows, a proportion bar of solid
  and hatched parts at the foot.
- **Build:** grid, `repeating-linear-gradient` hatching, a flex bar split by the real values.
- **Fonts:** Figtree 900, Noto Sans SC 900.
- **Avoid:** a proportion bar not drawn from the numbers.

### X04 Panorama Strip · bold · 90 %
From horizontal scrolls and continuous picture books. For anything that lines up: a set of objects, a timeline, a
pipeline, a route; it keeps people swiping right.
- **Mechanism:** three images are one picture joined by a line running through all (a wire or the horizon); the hero
  straddles a seam, about two thirds on the left image and one third on the right; each image still stands alone with
  its own number or title.
- **Cues:** folios only as 01 02 03.
- **Build:** one 3726 px wide strip cut into three; a cosine curve for the wire, its period across two images and its
  lowest point never on a seam; check no words cross a seam.
- **Fonts:** Figtree 900, Noto Sans SC 700/900.
- **Avoid:** text on a seam.

### X05 Daily Paper · neutral · 80 %
From a newspaper's front page: masthead, double rules, lead story, columns, drop cap, halftone photos, a news digest box.
For events: launches, reviews, deep method pieces, year summaries.
- **Mechanism:** the post is a front page: a widely tracked Song-style masthead, double rules, one number in the
  headline marked with a yellow highlighter.
- **Cues:** newsprint with fine noise; desaturated, contrasty pictures; a drop-cap column; inside, a boxed big score and
  a row of grey pictures as a diagram.
- **Build:** an inline SVG `feTurbulence` for noise, `grayscale` and `contrast` filters for photos (true halftone dots
  are out of reach), `::first-letter`.
- **Fonts:** Noto Serif SC 900/500, Bodoni Moda for the English masthead and the score.
- **Avoid:** colour photos; they break the paper.

### X06 Trading Cards · bold · 85 %
From collectible card games and field guides. For one card per item, a list worth collecting: species, products,
people, tools, cities.
- **Mechanism:** gold-framed cards with a name, a Latin or second name, a rank tag, a picture window, a number and two
  stat bars.
- **Cues:** a dark tabletop with a radial gradient; on the cover a big card over a tilted small one; inside, a 3×3 pack
  sorted by one real value.
- **Build:** a padded frame with a `linear-gradient` ground; stat bars as wide as the real values. Foil shine becomes
  multi-stop gradients.
- **Fonts:** Figtree 800/900, Noto Sans SC 700/900.
- **Avoid:** stats without real numbers.

### X07 Blank and Vertical · quiet · 90 %
From vertical Chinese books, seals, and albums with one thing per page. For slow content, stories, one object close up,
a quote; one or two in a set to let it breathe.
- **Mechanism:** a large empty page, a vertical Song-style title on the right, a long thin vertical subtitle, one red
  seal, the subject small and alone at the lower left.
- **Cues:** a number line top left, a short rule and a Latin name at the foot.
- **Build:** `writing-mode: vertical-rl`; the seal a red square with vertical characters. The space comes from the
  layout, not small type: vertical body text stays at 42 px or more.
- **Fonts:** Noto Serif SC 900/500.
- **Avoid:** a whole set in this mode.

### X08 Area Infographic · neutral · 95 %
From the treemap (Ben Shneiderman, early 1990s) and the waffle chart. For a set of hard numbers whose proportions must
read at a glance: composition, distribution, pass rates.
- **Mechanism:** a cover treemap where area is quantity (big cells hold a picture, small ones a name and a number, the
  smallest merged into "N others"); inside, a waffle where one cell is a fixed amount, four colours, with a legend of
  real numbers.
- **Build:** a squarify layout in about 20 lines of inline JS; the waffle as a CSS grid.
- **Fonts:** Figtree 900, Noto Sans SC 900.
- **Avoid:** a cell sized by hand.

---

## Styles HTML cannot carry

These live in generated images, 3D, particles, film lighting or hand illustration; in plain HTML they come out as a
poor mock. Offer them only when you can make images (`image_generate`), and then describe the mood, not the layout, in
the prompt: "warm like a Sunday morning" or "a Pentagram editorial feel" beats colour percentages and element lists.

| Style | Its soul | Why HTML fails |
|---|---|---|
| Active Theory (WebGL particles) | real-time 3D particle systems | CSS cannot |
| Field.io (generative art) | algorithmic forms | static SVG is a stiff copy |
| Resn (illustrated interaction) | characters and play | needs drawings |
| Zach Lieberman (live generation) | creative-coding strokes | needs real-time drawing |
| Raven Kwok (parametric fractals) | recursion | CSS cannot reach the complexity |
| Ash Thorp (film lighting) | volumetric light, concept art | CSS light is a lesser version |
| Territory Studio (sci-fi interfaces) | holograms | needs layered glowing art |
| Neo Shen (ink wash) | organic ink bleeds | a gradient is not ink |
| Sagmeister & Walsh (colour bursts) | handmade objects, experimental type | the clashing skeleton lives in W03 and P03; the handmade texture does not |

---
Adapted for pi-phone from `references/design-styles.md` and the overview sheets in `assets/style-specimens/` of
[huashu-design](https://github.com/alchaincyf/huashu-design)
by alchaincyf (花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
