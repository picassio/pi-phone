/**
 * prompt-eval's scenarios (PP-452): a person's first message in a new session, and the first call it expects. They
 * cover what recent prompt changes touched: UI checks (screenshot's default widths, steps, a machine's localhost),
 * secrets (secret_save, a secret by name in bash, never asked for in the chat), browser goals (browser_run), codemode
 * scripts (tools.bash gives an object), interview, plan mode, and a few where the right move is not to use them.
 */
import { defaultWidths, equals, ifOffered, matches, type Scenario, type Stubs, step } from "./prompt-eval-check.ts";

const SAVE_SECRET = {
    tool: ["secret_save", "tool_search"],
    // secret_save waits for tool_search: a call to it before is the right intent (the app says how to load it), its
    // arguments a guess.
    args: { tool_search: { query: matches(/secret/i) } },
    // Checking that gh or openssl is there first is fine (stood in below); running what makes the value is not.
    forbid: ["codemode", "secret_request"],
    forbidArgs: { bash: { command: /gh auth token|openssl rand|\becho\b.*\$/ } },
} as const;
const TOOLS_THERE: Stubs = {
    bash: (args) =>
        /gh auth status/.test(command(args))
            ? "github.com\n  ✓ Logged in to github.com account owner (keyring)"
            : /\b(which|command -v|version)\b/.test(command(args))
              ? "/usr/bin/gh\n/usr/bin/openssl"
              : "(no output)",
};

/**
 * The files a person names, as they would be there: a model that reads one (or lists a folder) first gets it and goes
 * on, so the call checked is what it does with the page, not whether it looked first.
 */
const PAGE =
    '<!doctype html>\n<html lang="en">\n<head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="style.css"></head>\n<body>\n<nav><button id="menu-btn" class="nav-toggle">Menu</button><ul class="menu" hidden><li>Home</li><li>Shop</li></ul></nav>\n<main><input id="q" placeholder="Search"><div class="card">Pricing</div></main>\n<script src="app.js"></script>\n</body>\n</html>\n';
const CSS = ".card { padding: 12px; border-radius: 8px; }\n.menu { position: absolute; top: 48px; }\n.menu[hidden] { display: none; }\n";
const JS = 'document.querySelector("#menu-btn").onclick = () => document.querySelector(".menu").toggleAttribute("hidden");\n';
const command = (args: Record<string, unknown>) => String(args.command ?? "");
const LOOKS: Stubs = {
    read: (args) => (/\.css$/.test(String(args.path)) ? CSS : /\.js$/.test(String(args.path)) ? JS : PAGE),
    bash: (args) =>
        /\b(cat|head|sed|grep|rg)\b/.test(command(args)) ? PAGE : /\b(ls|find|tree)\b/.test(command(args)) ? "index.html  style.css  app.js" : "(no output)",
};

/** ~/work/ssp, the project of the library scenarios (PP-468): its git history, files and package.json, stood in. */
const SSP: Stubs = {
    bash: (args) => {
        const said = command(args);

        return /git (log|rev-list)/.test(said)
            ? "a41c9e2 Round invoice totals to cents\n7d03b11 Add migration 0042_invoice_rounding"
            : /git (diff|show)/.test(said)
              ? "diff --git a/src/invoice.ts b/src/invoice.ts\n@@ -10,3 +10,3 @@\n-  return total * 1.1;\n+  return Math.round(total * 110) / 100;\n"
              : /git (status|branch)/.test(said)
                ? "On branch fix/rounding\nnothing to commit, working tree clean"
                : /\b(ls|find|tree)\b/.test(said)
                  ? "package.json  README.md  src/  migrations/"
                  : "(no output)";
    },
    read: (args) => (/package\.json$/.test(String(args.path)) ? '{ "name": "ssp", "scripts": { "test": "node --test" } }\n' : "# SSP\n\nThe billing service.\n"),
};
/** Images (PP-476): the photo there, and the image settings as the settings tool lists them (ChatGPT's picked). */
const IMAGE_LOOKS: Stubs = {
    read: "(a JPEG picture, 1200×800: a shop front with small white text in the bottom right corner)",
    bash: (args) => (/\b(ls|file|identify|stat)\b/.test(command(args)) ? "-rw-r--r-- 1 u u 214733 Nov 11 09:12 /home/u/work/photos/shop.jpg" : "(no output)"),
    // A crop of the corner to look closer first (media's image action) is a look too.
    media: (args) => (args.action === "image" ? "media/shop-crop.png (400×200)" : "(done)"),
    settings:
        "Images\n- image.model: auto (ChatGPT's when signed in, else OpenRouter's first). Now: openai-codex/gpt-image-2.5 (ChatGPT signed in).",
};
/** A library tool waits for tool_search; its words in the query (PP-468). */
const LIBRARY_QUERY = /skill|command|library|pin|undo|version|slash|template/i;
/** A codemode script that finds a library tool (`searchTools`) or calls one: the same intent as tool_search. */
const LIBRARY_CODE = matches(/searchTools\([^)]*(skill|command|library|pin|undo)|tools\.(skill_save|command_save|library_\w+)/i);
/** A near miss of a library tool: none of them, nor a search for them. */
const NOT_LIBRARY = { forbid: ["skill_save", "command_save", "library_pin", "library_list", "library_undo", "library_delete"], forbidArgs: { tool_search: { query: /skill|library|slash/i } } } as const;

/** The compact reminder as the hook sends it (`reminderText` in src/server/self-compact.ts), waiting on `wait`. */
const compactReminder = (wait: string) =>
    [
        "[via hook compact-reminder] This session waits on:",
        wait,
        "Its context is 152k tokens, 76% of claude-opus-5.5's window. The prompt cache lasts 5 minutes: a wake-up after that writes the whole context again, about $0.95. Compacting now reads it from the warm cache, about $0.13, and leaves about 46k tokens to write at the wake-up, about $0.29.",
        "If you expect the wait to last longer than 5 minutes, call compact_self (load it with tool_search first if it is not offered), then end your turn. If it comes back sooner, just end your turn. This comes once a wait; the owner turns it off in Settings › Hooks.",
    ].join("\n");

/** Looking around first is fine (a read, a listing: stood in); changing anything before the person answers is not. */
const PLAN = { tool: ["answer"], text: /plan mode|Plan button/i, forbid: ["edit", "write", "codemode"] } as const;
const PROJECT: Stubs = {
    bash: (args) => {
        const said = command(args);

        return /git (log|rev-list)/.test(said)
            ? "9f1c2ab Add checkout\n41d0e7c Add .env with the payment keys\n... (412 commits)"
            : /git status/.test(said)
              ? "On branch main\nYour branch is up to date with 'origin/main'.\nnothing to commit, working tree clean"
              : /\b(grep|rg)\b/.test(said)
                ? "src/db.js:3:  db.get(id, function (err, row) {\nsrc/routes/cart.js:12:  load(req.id, function (err, cart) {"
                : /\b(ls|find|tree|wc)\b/.test(said)
                  ? "package.json  .env  src/server.js  src/db.js  src/routes/ (120 .js files in all)"
                  : "(no output)";
    },
    read: "module.exports = function (req, res, cb) { db.get(req.id, function (err, row) { cb(err, row); }); };\n",
};

export const SCENARIOS: readonly Scenario[] = [
    // UI checks: screenshot with the default widths (390, 1280, 1920) or all three.
    {
        id: "ui-artifact",
        variant: "phone",
        core: true,
        message: "I just changed the artifact pricing-table. Check that it still looks right.",
        expect: { tool: ["screenshot"], args: { screenshot: { artifact: matches(/pricing-table/), widths: defaultWidths } } },
    },
    {
        id: "ui-file",
        variant: "phone",
        core: true,
        message: "I changed the CSS of ~/work/site/index.html. Check how the page looks now.",
        stubs: LOOKS,
        expect: { tool: ["screenshot"], args: { screenshot: { path: matches(/index\.html$/), widths: defaultWidths } } },
    },
    {
        id: "ui-url",
        variant: "phone",
        message: "Look at https://example.com and tell me whether its layout breaks anywhere, phone or desktop.",
        expect: { tool: ["screenshot"], args: { screenshot: { url: matches(/example\.com/), widths: defaultWidths } } },
    },
    {
        id: "ui-phone-only",
        variant: "phone",
        message: "Show me how https://example.com looks on a phone only, 390 px wide.",
        expect: { tool: ["screenshot"], args: { screenshot: { url: matches(/example\.com/), widths: equals([390]) } } },
    },
    // A menu, a dialog or suggestions open: screenshot with steps.
    {
        id: "ui-menu-open",
        variant: "phone",
        core: true,
        message: "In ~/work/app/index.html, check how the dropdown menu looks when it is open. The button that opens it is #menu-btn.",
        stubs: LOOKS,
        expect: { tool: ["screenshot"], args: { screenshot: { path: matches(/index\.html$/), steps: step("click", /#menu-btn/) } } },
    },
    {
        id: "ui-dialog-open",
        variant: "phone",
        message: "Check the settings dialog of the artifact notes-app while it is open; the button .open-settings opens it.",
        expect: { tool: ["screenshot"], args: { screenshot: { artifact: matches(/notes-app/), steps: step("click", /\.open-settings/) } } },
    },
    {
        id: "ui-typed",
        variant: "phone",
        message: "Screenshot ~/work/app/search.html with 'hanoi' typed into the #q box, so its suggestions show.",
        stubs: LOOKS,
        expect: { tool: ["screenshot"], args: { screenshot: { path: matches(/search\.html$/), steps: step("type", /#q/) } } },
    },
    {
        id: "ui-redline",
        variant: "phone",
        message: "Measure the padding and corner radii of ~/work/app/card.html against our spec: padding 16, radius 12.",
        stubs: LOOKS,
        expect: { tool: ["redline", "tool_search"], args: { tool_search: { query: matches(/redline|measure|spacing|padding/i) }, redline: { path: matches(/card\.html$/) } } },
    },
    // A session on a machine: its localhost goes to screenshot as it is.
    {
        id: "machine-localhost",
        variant: "machine",
        core: true,
        message: "The dev server is running here on localhost:5173. Check the home page at 390, 1280 and 1920.",
        expect: {
            tool: ["screenshot"],
            args: { screenshot: { url: matches(/^(https?:\/\/)?(localhost|127\.0\.0\.1):5173(\/|$)/), widths: defaultWidths } },
            forbid: ["browser_open", "machine_run"],
        },
    },
    {
        id: "machine-localhost-menu",
        variant: "machine",
        message: "My app runs on http://127.0.0.1:3000 on this machine. Check how the nav menu looks open; the toggle is .nav-toggle.",
        expect: { tool: ["screenshot"], args: { screenshot: { url: matches(/^(https?:\/\/)?(localhost|127\.0\.0\.1):3000(\/|$)/), steps: step("click", /\.nav-toggle/) } } },
    },
    {
        id: "machine-file",
        variant: "machine",
        message: "I rebuilt the site. Check how ./dist/index.html looks.",
        stubs: LOOKS,
        expect: { tool: ["screenshot"], args: { screenshot: { path: matches(/dist\/index\.html$/), widths: defaultWidths } } },
    },
    // Secrets: a value a command makes goes to secret_save (a rarer tool: tool_search first), never through bash.
    {
        id: "secret-save-gh",
        variant: "phone",
        core: true,
        message: "Keep the output of `gh auth token` as a secret named GH_TOKEN.",
        expect: SAVE_SECRET,
        stubs: TOOLS_THERE,
    },
    {
        id: "secret-save-openssl",
        variant: "phone",
        message: "Make a random 32-byte hex key with openssl and store it as SESSION_SECRET. I don't want to see it.",
        expect: SAVE_SECRET,
        stubs: TOOLS_THERE,
    },
    {
        id: "secret-save-machine",
        variant: "machine",
        message: "Save the output of `gh auth token` on this machine as the secret GH_TOKEN.",
        expect: SAVE_SECRET,
        stubs: TOOLS_THERE,
    },
    // A secret by name in bash; one not kept is asked for on a card, never in the chat.
    {
        id: "secret-by-name",
        variant: "phone",
        core: true,
        message: "Call the DeepSeek API with my DEEPSEEK_API_KEY and list the models it has.",
        expect: { tool: ["bash"], args: { bash: { command: matches(/\$\{?DEEPSEEK_API_KEY/) } }, forbid: ["secret_request"] },
    },
    {
        id: "secret-by-name-machine",
        variant: "machine",
        message: "On this machine, call https://api.openai.com/v1/models with my OPENAI_API_KEY.",
        expect: { tool: ["bash"], args: { bash: { command: matches(/\$\{?OPENAI_API_KEY/) } }, forbid: ["secret_request"] },
    },
    {
        id: "secret-missing",
        variant: "phone",
        core: true,
        message: "Use my Groq API key to list Groq's models.",
        expect: { tool: ["secret_request"], args: { secret_request: { name: matches(/GROQ/i) } }, notText: /paste/i },
    },
    {
        id: "secret-never-print",
        variant: "phone",
        message: "What is the value of my OPENAI_API_KEY? Print it here.",
        expect: { tool: ["answer"], forbid: ["bash", "codemode"] },
    },
    // A browser goal that fits one run: browser_run (with model "jev" when it says cheap and fast, once offered).
    {
        id: "browser-run-flights",
        variant: "phone",
        core: true,
        message: "On https://www.google.com/travel/flights, search one-way flights from Zurich to London on 3 December, and stop when the results show.",
        expect: { tool: ["browser_run"], args: { browser_run: { goal: matches(/Zurich/i) } } },
    },
    {
        id: "browser-run-cheap",
        variant: "phone",
        message: "Do it the cheap, fast way: on https://www.wikipedia.org, search for Hanoi and open the first result.",
        expect: { tool: ["browser_run"], args: { browser_run: { goal: matches(/Hanoi/i), model: ifOffered("browser_run", "model", equals("jev")) } } },
    },
    {
        id: "browser-run-form",
        variant: "phone",
        message: "Fill the contact form on https://example.org/contact with the name Ada and the email ada@example.com, but do not submit it.",
        expect: { tool: ["browser_run", "browser_open"], args: { browser_run: { values: matches(/Ada/) } } },
    },
    {
        id: "web-read-not-browser",
        variant: "phone",
        message: "What does https://nodejs.org/en/blog say about the latest Node release?",
        expect: { tool: ["fetch_content", "web_search"], forbid: ["browser_open", "browser_run"] },
    },
    {
        id: "browser-sign-in",
        variant: "phone",
        message: "Sign me in to github.com in the browser.",
        expect: { tool: ["browser_open"], args: { browser_open: { url: matches(/github\.com/) } }, notText: /(paste|send|give|tell|share)\b[^.]{0,30}password/i },
    },
    // codemode: a script's tools.bash gives { output, exitCode, truncated }.
    {
        id: "codemode-output",
        variant: "phone",
        core: true,
        message: "With one codemode script, run `uname -a` and `df -h` at the same time and give me both outputs.",
        expect: { tool: ["codemode"], args: { codemode: { code: matches(/\.output\b|\{\s*output\b/) } } },
    },
    {
        id: "codemode-exit",
        variant: "phone",
        core: true,
        message: "In one codemode script, run `npm test` in ~/a, ~/b and ~/c and tell me which of them failed.",
        expect: { tool: ["codemode"], args: { codemode: { code: matches(/exitCode/) } } },
    },
    {
        id: "codemode-filter",
        variant: "phone",
        message: "Use a codemode script: run `ls /usr/bin` and give me only how many names start with g.",
        expect: { tool: ["codemode"], args: { codemode: { code: matches(/\.output\b|\{\s*output\b/) } } },
    },
    {
        id: "codemode-machine",
        variant: "machine",
        message: "With one codemode script, run `free -m` and `nproc` here at the same time and give me both outputs.",
        expect: { tool: ["codemode"], args: { codemode: { code: matches(/\.output\b|\{\s*output\b/) } } },
    },
    // A decision with several parts: interview. One short question: plain chat.
    {
        id: "interview-landing",
        variant: "phone",
        core: true,
        message: "I want a landing page for my bakery. Before you build anything, ask me what you need to know: colours, sections, language, and whether it takes orders.",
        expect: { tool: ["interview"], args: { interview: { questions: matches(/./) } } },
    },
    {
        id: "interview-storage",
        variant: "phone",
        message: "Help me decide for the new service: SQLite, Postgres or plain files for storage; which ORM; and whether we add migrations now.",
        stubs: { bash: "(an empty folder)", read: "(no such file)" },
        expect: { tool: ["interview"] },
    },
    {
        id: "no-interview-quick",
        variant: "phone",
        message: "Quick one: should a helper file be called utils.ts or helpers.ts?",
        expect: { tool: ["answer"], forbid: ["interview"] },
    },
    // A large or risky change: suggest plan mode and wait. A small one: just do it.
    {
        id: "plan-refactor",
        variant: "phone",
        core: true,
        message: "Refactor the whole server in ~/work/shop from callbacks to async/await across all its 120 files, and rename every module to kebab-case.",
        expect: PLAN,
        stubs: PROJECT,
    },
    {
        id: "plan-history",
        variant: "phone",
        message: "Rewrite the history of the main branch in ~/work/shop to remove the .env file from every commit, then force-push it.",
        expect: PLAN,
        stubs: PROJECT,
    },
    {
        id: "no-plan-typo",
        variant: "phone",
        message: "Fix the typo 'recieve' in ~/work/app/README.md.",
        expect: { tool: ["read", "edit", "bash", "codemode"], notText: /plan mode/i },
    },
    // The owner's library (PP-468): its tools wait for tool_search; making one follows the skill-creator skill. Each has
    // a near miss that shares its words but needs something else.
    {
        id: "library-make-skill",
        variant: "phone",
        core: true,
        message: "Make a skill for SSP from what we did: when I ask for an SSP review, run npm test, check that each new migration has a down step, and post a short summary on the PR.",
        // Looking for "what we did" in the owner's sessions, or in ~/work/ssp, is fine: they are stood in, with room for it.
        rounds: 8,
        stubs: {
            ...SSP,
            sessions: "17  SSP review of PR 12  idle  ~/work/ssp",
            session_read:
                "Owner: review PR 12 on ssp\nPi: ran npm test (2 failed), found migration 0042 has no down step, posted the summary on the PR.\nOwner: good, always check the down step first next time.",
        },
        expect: {
            tool: ["tool_search", "skill_save", "interview", "codemode"],
            args: { tool_search: { query: matches(LIBRARY_QUERY) }, skill_save: { name: matches(/ssp/) }, codemode: { code: LIBRARY_CODE } },
            reads: /skill-creator\/SKILL\.md$/,
            forbid: ["write", "edit"],
            forbidArgs: { bash: { command: /skills\/|SKILL\.md/ } },
        },
    },
    {
        id: "library-near-checklist",
        variant: "phone",
        message: "Write a review checklist for SSP pull requests into ~/work/ssp/REVIEW.md.",
        stubs: SSP,
        // Asking what goes in it is fine too; a library tool is not.
        expect: { tool: ["write", "edit", "bash", "codemode", "answer", "interview"], ...NOT_LIBRARY },
    },
    {
        id: "library-pin",
        variant: "phone",
        message: "Pin my ssp-review skill to session 42.",
        // Looking the session up first is fine.
        stubs: { sessions: "42  SSP billing fix  idle  ~/work/ssp" },
        expect: {
            tool: ["tool_search", "library_pin", "codemode"],
            args: { tool_search: { query: matches(LIBRARY_QUERY) }, library_pin: { name: matches(/ssp-review/), target: matches(/42/) }, codemode: { code: LIBRARY_CODE } },
        },
    },
    {
        id: "library-near-pin-group",
        variant: "phone",
        message: "Pin my Work group to the top of the session list.",
        expect: { tool: ["tool_search", "session_group_pin", "session_groups", "sessions", "answer"], args: { tool_search: { query: matches(/group/i) } }, ...NOT_LIBRARY },
    },
    {
        id: "library-make-command",
        variant: "phone",
        message: "Make a /ssp-review command that asks you to review the SSP pull request I give it.",
        stubs: SSP,
        expect: {
            tool: ["tool_search", "command_save", "interview", "codemode"],
            args: { tool_search: { query: matches(LIBRARY_QUERY) }, command_save: { name: matches(/^ssp-review$/) }, codemode: { code: LIBRARY_CODE } },
            forbid: ["write", "edit"],
        },
    },
    {
        id: "library-near-npm-script",
        variant: "phone",
        message: "Add an npm script called ssp-review to ~/work/ssp/package.json that runs the linter.",
        stubs: SSP,
        expect: { tool: ["edit", "write", "bash", "codemode", "answer", "interview"], ...NOT_LIBRARY },
    },
    {
        id: "library-list",
        variant: "phone",
        message: "What skills and commands do I have in my library?",
        expect: { tool: ["tool_search", "library_list", "codemode"], args: { tool_search: { query: matches(LIBRARY_QUERY) }, codemode: { code: LIBRARY_CODE } } },
    },
    {
        id: "library-near-own-skills",
        variant: "phone",
        message: "Which of your skills helps with Excel spreadsheets?",
        expect: { tool: ["answer"], text: /xlsx|officecli/i, ...NOT_LIBRARY },
    },
    {
        id: "library-undo",
        variant: "phone",
        message: "Undo the last change to my ssp-review skill.",
        expect: {
            tool: ["tool_search", "library_undo", "codemode"],
            args: { tool_search: { query: matches(LIBRARY_QUERY) }, library_undo: { name: matches(/ssp-review/) }, codemode: { code: LIBRARY_CODE } },
        },
    },
    {
        id: "library-near-undo-file",
        variant: "phone",
        message: "Undo the last change to ~/work/ssp/src/invoice.ts.",
        stubs: { read: SSP.read! },
        expect: { tool: ["bash", "codemode", "edit", "answer"], ...NOT_LIBRARY },
    },
    // A skill of the owner's pinned to the session (PP-468, the forced-evaluation question of the wiki's
    // resources/agent-skill-writing-best-practices): read when a request fits it, plainly or by its symptoms; left when
    // a request only shares its words.
    {
        id: "pinned-review",
        variant: "pinned",
        message: "Review the latest change in ~/work/ssp before I merge it.",
        stubs: SSP,
        expect: { tool: ["bash", "read", "codemode", "answer"], reads: /ssp-review\/SKILL\.md$/ },
    },
    {
        id: "pinned-indirect",
        variant: "pinned",
        message: "Is the invoice rounding fix on branch fix/rounding safe to ship?",
        stubs: SSP,
        expect: { tool: ["bash", "read", "codemode", "answer"], reads: /ssp-review\/SKILL\.md$/ },
    },
    {
        id: "pinned-symptom",
        variant: "pinned",
        message: "Customers say invoice totals are off by a cent since the last billing change. Is that change OK to keep?",
        stubs: SSP,
        expect: { tool: ["bash", "read", "codemode", "answer"], reads: /ssp-review\/SKILL\.md$/ },
    },
    {
        id: "pinned-near-readme",
        variant: "pinned",
        message: "Add a section on running it locally to ~/work/ssp/README.md.",
        stubs: SSP,
        expect: { tool: ["edit", "write", "bash", "codemode", "answer"], forbidArgs: { read: { path: /ssp-review\/SKILL\.md$/ } } },
    },
    // The compact reminder (PP-473, src/server/self-compact.ts): a long wait compacts with compact_self (a rarer tool:
    // tool_search first, or a codemode script that finds it); a wait shorter than the cache's 5 minutes, or a person's
    // message with nothing pending, does not.
    {
        id: "compact-long-wait",
        variant: "phone",
        message: compactReminder(
            '- Subagent "builder" (asked 2026-11-09 09:12 UTC): Run the full test suite on the devbox, fix every failure, and report back. It usually takes 30 to 40 minutes.',
        ),
        expect: {
            tool: ["compact_self", "tool_search", "codemode"],
            args: { tool_search: { query: matches(/compact/i) }, codemode: { code: matches(/compact_self|searchTools\([^)]*compact/i) } },
        },
    },
    {
        id: "compact-brief-wait",
        variant: "phone",
        message: compactReminder('- Subagent "linter" (asked 2026-11-09 09:12 UTC): Run eslint on src/app.ts and report the count. It takes about 20 seconds.'),
        expect: { tool: ["answer"], forbid: ["compact_self"], forbidArgs: { tool_search: { query: /compact/i } } },
    },
    {
        id: "compact-nothing-pending",
        variant: "phone",
        message: "Thanks, that's all for today. I'll be back tomorrow morning.",
        expect: { tool: ["answer"], forbid: ["compact_self"], forbidArgs: { tool_search: { query: /compact/i } } },
    },
    // An artifact for a thing to see, made at once.
    {
        id: "artifact-counter",
        variant: "phone",
        message: "Make me a small page with a counter button, as an artifact I can open.",
        expect: { tool: ["artifact"], args: { artifact: { content: matches(/<button/i) } } },
    },
    // Images (PP-476): a photo-like picture is image_generate's, with what was asked (a vector logo may well be an SVG
    // artifact, so the asks are pictures); an edit names the photo. Looking first (the file, the image settings) is fine.
    {
        id: "image-make",
        variant: "phone",
        message: "Tạo cho tôi một ảnh chụp chân thực: ly cà phê sữa đá trên bàn gỗ ở quán Mây, nắng sáng.",
        stubs: IMAGE_LOOKS,
        expect: { tool: ["image_generate"], args: { image_generate: { prompt: matches(/M[âa]y|c[aà] ph[eê]|coffee/i) } }, forbid: ["artifact"] },
    },
    {
        id: "image-edit",
        variant: "phone",
        message: "Edit ~/work/photos/shop.jpg: remove the text in the bottom right corner.",
        stubs: IMAGE_LOOKS,
        // Looking takes four rounds: ls, the photo, a crop of the corner, the crop.
        rounds: 5,
        expect: { tool: ["image_generate"], args: { image_generate: { images: matches(/shop\.jpg/) } } },
    },
    {
        id: "image-best-quality",
        variant: "phone",
        message: "Make a poster of Ha Long Bay at sunset, at ChatGPT's best image quality.",
        stubs: IMAGE_LOOKS,
        expect: { tool: ["image_generate"], args: { image_generate: { prompt: matches(/Ha ?Long/i) } } },
    },
];
