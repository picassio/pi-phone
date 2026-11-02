// brand-extract's measurement (PP-240): give this whole file as browser_eval's expression, on a page of the brand's site
// in Pi's browser. It reads the page's computed styles, nothing else (browser_eval's world has no network or storage),
// and answers what a design system's tokens are made of, each value with how much of the page uses it:
// - colours: text colours weighted by visible characters, backgrounds and borders by visible area, as hex;
// - roles it can see: the page's background and text, links, the main buttons, headings;
// - type: the font stacks of the body, headings, buttons and code, each heading level's size, weight, line height and
//   tracking, the font sizes by characters set in them, and the faces the page loaded;
// - spacing (paddings, margins and gaps), radii, shadows, the content's widest container, and the :root custom
//   properties that name colours, fonts, sizes or radii.
(() => {
    const LIMIT = 4000;
    const all = [document.body, ...document.body.querySelectorAll("*")].slice(0, LIMIT);
    const view = { width: innerWidth, height: innerHeight };
    const round = (n) => Math.round(n * 100) / 100;
    const hex = (value) => {
        const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(value);

        if (m === null) {
            return value;
        }

        const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);

        if (alpha === 0) {
            return null;
        }

        const h = [m[1], m[2], m[3]].map((part) => Math.round(Number(part)).toString(16).padStart(2, "0")).join("");

        return alpha < 1 ? `#${h}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : `#${h}`;
    };
    const tally = () => new Map();
    const add = (map, key, weight) => {
        if (key !== null && key !== undefined && key !== "" && weight > 0) {
            map.set(key, (map.get(key) ?? 0) + weight);
        }
    };
    const top = (map, n, total) => {
        const sum = total ?? [...map.values()].reduce((a, b) => a + b, 0);

        return [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, weight]) => ({ value, share: sum === 0 ? 0 : round(weight / sum) }));
    };
    const visible = (el, style, rect) => style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && rect.width > 0 && rect.height > 0;
    const ownText = (el) => {
        let n = 0;

        for (const node of el.childNodes) {
            if (node.nodeType === 3) {
                n += node.textContent.trim().length;
            }
        }

        return n;
    };

    const text = tally();
    const background = tally();
    const border = tally();
    const sizes = tally();
    const families = tally();
    const spacing = tally();
    const radii = tally();
    const shadows = tally();
    let widest = 0;

    for (const el of all) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        if (!visible(el, style, rect)) {
            continue;
        }

        const chars = ownText(el);
        const area = Math.min(rect.width, view.width) * Math.min(rect.height, view.height * 3);

        add(text, chars > 0 ? hex(style.color) : null, chars);
        add(sizes, chars > 0 ? style.fontSize : null, chars);
        add(families, chars > 0 ? style.fontFamily : null, chars);
        add(background, hex(style.backgroundColor), area);

        for (const side of ["Top", "Right", "Bottom", "Left"]) {
            const width = parseFloat(style[`border${side}Width`]);

            if (width > 0 && style[`border${side}Style`] !== "none") {
                add(border, hex(style[`border${side}Color`]), side === "Top" || side === "Bottom" ? rect.width : rect.height);
            }
        }

        for (const value of [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft, style.marginTop, style.marginBottom, style.rowGap, style.columnGap]) {
            const px = parseFloat(value);

            if (px > 0 && px <= 160) {
                add(spacing, `${Math.round(px)}px`, 1);
            }
        }

        if (style.borderTopLeftRadius !== "0px") {
            add(radii, style.borderTopLeftRadius, 1);
        }

        if (style.boxShadow !== "none") {
            add(shadows, style.boxShadow, 1);
        }

        // A centred box narrower than the page: its max-width when it has one (the container's own rule), else its width.
        if (rect.width < view.width - 1 && style.marginLeft === style.marginRight && parseFloat(style.marginLeft) > 0) {
            widest = Math.max(widest, Math.round(style.maxWidth.endsWith("px") ? parseFloat(style.maxWidth) : rect.width));
        }
    }

    const describe = (el) => {
        if (el === null) {
            return null;
        }

        const style = getComputedStyle(el);

        return {
            text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
            color: hex(style.color),
            background: hex(style.backgroundColor),
            border: parseFloat(style.borderTopWidth) > 0 ? `${style.borderTopWidth} ${hex(style.borderTopColor)}` : null,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            textTransform: style.textTransform === "none" ? null : style.textTransform,
            padding: style.padding,
            radius: style.borderRadius,
            shadow: style.boxShadow === "none" ? null : style.boxShadow,
        };
    };
    const shown = (selector, n) =>
        [...document.querySelectorAll(selector)]
            .filter((el) => {
                const rect = el.getBoundingClientRect();

                return visible(el, getComputedStyle(el), rect) && (el.textContent ?? "").trim() !== "";
            })
            .slice(0, n);
    const buttons = shown("button, [role=button], a[class*=btn], a[class*=button], a[class*=Button], input[type=submit]", 40)
        .map(describe)
        .filter((each) => each.background !== null || each.border !== null);
    const filled = tally();

    for (const each of buttons) {
        add(filled, each.background, 1);
    }

    const rootStyle = getComputedStyle(document.documentElement);
    const custom = {};
    const names = new Set();

    for (const sheet of document.styleSheets) {
        let rules;

        try {
            rules = sheet.cssRules;
        } catch {
            continue;
        }

        for (const rule of rules ?? []) {
            if (rule.selectorText === ":root" || rule.selectorText === "html" || rule.selectorText === ":root, :host") {
                for (const name of rule.style) {
                    if (name.startsWith("--")) {
                        names.add(name);
                    }
                }
            }
        }
    }

    for (const name of [...names].filter((each) => /color|colour|bg|background|fg|text|font|accent|primary|brand|surface|border|radius|space|spacing|gap|shadow|size/i.test(each)).slice(0, 120)) {
        custom[name] = rootStyle.getPropertyValue(name).trim();
    }

    const faces = [];

    try {
        document.fonts.forEach((face) => {
            if (face.status === "loaded" && faces.length < 20) {
                faces.push(`${face.family.replace(/"/g, "")} ${face.weight} ${face.style}`);
            }
        });
    } catch {
        // document.fonts unreadable here: the families above still name the stacks.
    }

    const headings = {};

    for (const level of ["h1", "h2", "h3", "h4"]) {
        const el = shown(level, 1)[0] ?? null;

        if (el !== null) {
            headings[level] = describe(el);
        }
    }

    const bodyStyle = getComputedStyle(document.body);
    const paragraph = shown("p", 1)[0] ?? null;
    const code = shown("code, pre, kbd", 1)[0] ?? null;
    const theme = document.querySelector('meta[name="theme-color"]');

    return {
        url: location.href,
        title: document.title,
        viewport: view,
        measured: all.length,
        colorScheme: rootStyle.colorScheme,
        themeColor: theme === null ? null : theme.getAttribute("content"),
        page: {
            background: hex(bodyStyle.backgroundColor) ?? hex(rootStyle.backgroundColor) ?? "#ffffff (none set)",
            text: hex(bodyStyle.color),
            fontFamily: bodyStyle.fontFamily,
            fontSize: bodyStyle.fontSize,
            lineHeight: bodyStyle.lineHeight,
        },
        paragraph: describe(paragraph),
        headings,
        link: describe(shown("main a, article a, p a", 1)[0] ?? shown("a", 1)[0] ?? null),
        buttons: buttons.slice(0, 6),
        buttonFills: top(filled, 5),
        code: code === null ? null : { fontFamily: getComputedStyle(code).fontFamily, fontSize: getComputedStyle(code).fontSize },
        colors: { text: top(text, 12), background: top(background, 12), border: top(border, 8) },
        type: { families: top(families, 6), sizes: top(sizes, 14), loadedFaces: faces },
        spacing: top(spacing, 16),
        radii: top(radii, 8),
        shadows: top(shadows, 5),
        container: widest === 0 ? null : `${widest}px`,
        customProperties: custom,
    };
})()
