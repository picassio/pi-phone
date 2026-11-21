# Critique: is this design good?

For when the person asks you to review, judge or score a design (theirs, yours, a site, a deck): a scored review
with reasons, not a list of likes. The layout check's numbers come first (this skill's step 1): a page with must-fix
findings is not judged on taste until they are named.

## 0. Concept first, and it caps the rest

Ask whether the design has an idea before asking whether it is well made. Execution amplifies: an empty concept made
beautifully is still empty.

| Score | Concept |
|---|---|
| 9–10 | An idea grown from this content; its visual motif could not be swapped for another |
| 7–8 | A clear idea; the motif fits the content, though a nearby subject could borrow it |
| 5–6 | A style, no concept: it looks good and says nothing |
| 3–4 | A template reskinned; nothing at the level of an idea |
| 1–2 | Not even the right style; decoration piled up |

- What does this design say? Can you put its idea in one sentence? If you cannot, it has none.
- Cover every word and logo: can you still tell the subject? If not, the visuals carry nothing. (For a design whose
  motif is its type, ask instead: would this treatment of the type work for another subject?)
- Change the client's or product's name: does it still work? **If it does, it is a template, and concept is 5 at
  most.**
- Does the form carry a motif only this content has?

**The cap:** with concept at 5 or less, the overall score is 6.0 at most. The other five dimensions are execution, and
polish cannot rescue a design with no idea: it only makes the template shine.

## 1–5. Execution

| Dimension | 9–10 | 5–6 | 1–2 |
|---|---|---|---|
| **Philosophy**: true to the direction chosen | Every detail follows from the chosen designer's or style's core | The intent shows, but other styles leak in | Unrelated to it |
| **Hierarchy** | The eye moves where the designer meant, without friction | Headings and body separate; the middle levels blur | No idea where to look first |
| **Craft** | Exact alignment, spacing and colour, no flaw | Roughly aligned; spacing uneven, colour not a system | Rough, like a draft |
| **Function** | Every element serves the goal; nothing to remove | Usable, with decoration that distracts | Drowned in decoration |
| **Originality** | Fresh, a voice of its own within the style | Competent, looks like a template | Templates and stock pieces |

What to check for each:

- **Philosophy:** does it use the source's signature moves? Do colour, type and layout belong to that system? Anything
  that contradicts it (a Kenya Hara direction stuffed with content)?
- **Hierarchy:** headline to body 2.5× or more; three or four clear levels from size, weight and colour; white space
  that leads the eye; the squint test.
- **Craft:** one spacing system (the 4 px grid the layout check measures); like elements spaced alike; three or four
  colours; two typefaces at most; exact edges.
- **Function:** would removing any element make it worse? (If not, remove it.) Is the key message or action where the
  eye lands? Is anything there only because it looks nice? Does the density fit the medium (a slide sparse, a PDF
  denser)?
- **Originality:** free of the usual clichés (below)? A decision that is unexpected but right?

## Weight by medium

Concept is the first gate everywhere and is not weighed here.

| Medium | Weighs most | Then | Can relax |
|---|---|---|---|
| Social cover or article image | Originality, hierarchy | Philosophy | Function (no interaction) |
| Infographic | Function, hierarchy | Craft | Originality (accuracy first) |
| Slides | Hierarchy, function | Craft | Originality (clarity first) |
| PDF or white paper | Craft, function | Hierarchy | Originality (professional first) |
| Landing page or site | Function, hierarchy | Originality | Nothing |
| App UI | Function, craft | Hierarchy | Philosophy (usability first) |
| Carousel (Xiaohongshu, Instagram) | Originality, hierarchy | Philosophy | Craft (mood first) |

## Common problems

1. **AI clichés:** glowing orbs, digital rain, blue circuit boards, robot faces. Use a metaphor of what it does (a
   conversation) instead of the obvious symbol.
2. **Too little size contrast:** headline under 2.5× the body. Make it 3× or more (16 px body, 48–64 px headline).
3. **Too many colours:** five or more with no order. One main, one second, one accent, and greys.
4. **Uneven spacing:** no system. Spacing from one scale (8/16/24/32/48/64, or the 4 px grid).
5. **No room:** every inch filled. Leave about 40 % of the area empty (60 % or more for a minimal style).
6. **Too many typefaces:** three or more. Two at most; vary weight and size.
7. **Mixed alignment:** left, centred and right side by side. Choose one (usually left).
8. **Decoration over content:** patterns, gradients and shadows that upstage the message. Would removing it make the
   design worse? If not, remove it.
9. **Cyber neon:** an even #0D1117 navy with neon glow, one of the commonest clichés (a brand's own palette may
   override). Draw a palette from the subject (`design-artifact`'s `references/colour-type.md`).
10. **Density wrong for the medium:** a slide full of text, a cover with ten elements. A slide holds one idea, a cover
    one focal point, an infographic layers, a PDF can be dense with clear navigation.

unslop's `references/signs.md` lists the finer tells (gradient text, uppercase tracked labels, pulsing dots, and the
rest); name the ones you see.

## The report

Write it in the person's language:

```
Overall: X.X / 10 (excellent 8+, good 6–7.9, needs work 4–5.9, failing under 4)
(Concept 5 or less caps the overall at 6: fix the idea before the execution.)

- Concept: X / 10. Its idea in one sentence, or "none".
- Philosophy: X / 10. One sentence.
- Hierarchy: X / 10. One sentence.
- Craft: X / 10. One sentence.
- Function: X / 10. One sentence.
- Originality: X / 10. One sentence.

Keep: what works, in design terms.

Fix, worst first, each marked fatal, important or polish:
1. The problem: what it is now; why it is a problem; the fix, with numbers.

Five minutes only: the three fixes that do the most.
```

Show the picture you judged (embed the screenshot), and for each fix, point at where it is.

---
Adapted for pi-phone from `references/critique-guide.md` of
[huashu-design](https://github.com/alchaincyf/huashu-design)
by alchaincyf (花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
