/**
 * Steps before the shot (PP-423): what a person would do to a page before it is pictured and measured, so the
 * screenshot tool and redline see states that only show after a tap (a ⋯ menu, a picker, a dialog). The steps run in
 * the page itself, as a script both renderers start (the phone's `Renderer.java`, the server's `chrome-renderer.ts`):
 * it runs them one by one and keeps where it is in `window.__piSteps`, which the renderer reads every 100 ms until
 * they are done or one failed; then the page is measured and pictured. Per width, after the page is laid out at its
 * picture's height.
 *
 * - `{ click: selector }`: pointer and mouse down and up on the element's middle, then its click;
 * - `{ type: selector, text }`: the field's value set as typing would (an input event the page hears), or text inserted
 *   into an editable element;
 * - `{ type: selector, secret: NAME }` (PP-500): one of the owner's saved secrets typed so, into a password field only (its
 *   picture shows dots); the tool looks its value up (`value`), which goes into the page's script and nowhere else: the
 *   step is said by its name (`stepWords`), and errors name the selector;
 * - `{ press: key }`: keydown and keyup of `key` ("Escape", "Enter", "ArrowDown", "a") at the element in focus: the
 *   page's own key handlers, not the browser's default actions (Tab does not move the focus);
 * - `{ wait: ms }` (at most 10 000) or `{ wait: selector }` (until a visible element matches, 5 s at most).
 * A click or type waits up to 2 s for its element, as a page that renders after the previous step needs. A step that
 * cannot be done fails the render, saying which step and why.
 *
 * A step may load another page (a sign-in form sent, PP-500): the script is gone with its page. `__piSteps.resume` says
 * how many steps have done what they do (a wait once it matched); a renderer that reads no state any more (a new page)
 * waits for the new page to load and starts the script again there from that step (`window.__piStepsFrom`), up to
 * `MAX_PAGES` pages, then measures the page's height again. A click or a key may load one before the renderer's next
 * read, so it waits until the renderer has read that it counts as done (`seen`, which each read of `STEPS_STATE` sets),
 * and only then acts: a renderer that read an earlier count would do it again on the new page (the fixture's sign-in
 * clicked a button the next page lacks). A renderer from before PP-500 never sets `seen`: after 1 s without it, the
 * steps go on without waiting.
 */

export type RenderStep = { click: string } | { type: string; text: string } | { type: string; secret: string; value?: string } | { press: string } | { wait: number | string };

export const MAX_STEPS = 12;
const MAX_WAIT_MS = 10_000;
/** All waits of a list together: the renderer gives the steps 20 s. */
const MAX_WAITS_MS = 15_000;
/** How long a renderer waits for the steps to finish. */
export const STEPS_MS = 20_000;
/** What a renderer evaluates to read where the steps are: JSON text, or "null" before they started. */
export const STEPS_STATE = "JSON.stringify(window.__piSteps ? Object.assign(window.__piSteps, { seen: window.__piSteps.resume }) : null)";

export type StepsState = { state: "running" | "done" | "failed"; at: number; resume?: number; seen?: number; error?: string };

/** The pages steps may go through (each load starts the script again): a loop of loads fails the render. */
export const MAX_PAGES = 5;
/** What a renderer evaluates on a new page to go on with the steps from `from` (0-based): then the steps' script. */
export const stepsFrom = (from: number): string => `window.__piStepsFrom = ${from};`;

/** A step in words, for errors and answers. */
export function stepWords(step: RenderStep): string {
    if ("click" in step) {
        return `click ${JSON.stringify(step.click)}`;
    }

    if ("secret" in step) {
        return `type [secret ${step.secret}] into ${JSON.stringify(step.type)}`;
    }

    if ("type" in step) {
        return `type into ${JSON.stringify(step.type)}`;
    }

    if ("press" in step) {
        return `press ${step.press}`;
    }

    return typeof step.wait === "number" ? `wait ${step.wait} ms` : `wait for ${JSON.stringify(step.wait)}`;
}

/** The steps as given, or why they cannot run: each one shape, selectors and keys not empty, the waits within bounds. */
export function checkSteps(steps: readonly unknown[]): RenderStep[] | { error: string } {
    if (steps.length > MAX_STEPS) {
        return { error: `steps are ${MAX_STEPS} at most.` };
    }

    let waits = 0;
    const checked: RenderStep[] = [];

    for (const [index, raw] of steps.entries()) {
        const step = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
        const keys = Object.keys(step).sort().join(",");
        const bad = (why: string) => ({ error: `Step ${index + 1}: ${why}` });
        const text = (value: unknown) => typeof value === "string" && value.trim() !== "";

        if (keys === "click" && text(step.click)) {
            checked.push({ click: step.click as string });
        } else if (keys === "text,type" && text(step.type) && typeof step.text === "string") {
            checked.push({ type: step.type as string, text: step.text });
        } else if (keys === "secret,type" && text(step.type) && typeof step.secret === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.secret)) {
            checked.push({ type: step.type as string, secret: step.secret });
        } else if (keys === "press" && text(step.press)) {
            checked.push({ press: step.press as string });
        } else if (keys === "wait" && typeof step.wait === "number") {
            if (!Number.isFinite(step.wait) || step.wait < 0 || step.wait > MAX_WAIT_MS) {
                return bad(`wait is 0 to ${MAX_WAIT_MS} ms.`);
            }

            waits += step.wait;
            checked.push({ wait: step.wait });
        } else if (keys === "wait" && text(step.wait)) {
            waits += 5000;
            checked.push({ wait: step.wait as string });
        } else {
            return bad("each step is one of { click: selector }, { type: selector, text }, { type: selector, secret: NAME } (a saved secret, into a password field), { press: key }, { wait: ms or selector }.");
        }
    }

    return waits > MAX_WAITS_MS ? { error: `the steps wait ${waits} ms in all (a wait for a selector counts 5000); ${MAX_WAITS_MS} at most.` } : checked;
}

/**
 * The script that runs `steps` in the page: it answers at once, and the steps go on; `STEPS_STATE` says how far. Started
 * again on a page a step loaded, after `stepsFrom`, it goes on from there. A secret step needs its value looked up.
 */
export function stepsScript(steps: readonly RenderStep[]): string {
    const unread = steps.find((step) => "secret" in step && step.value === undefined);

    if (unread !== undefined) {
        throw new Error(`The secret ${(unread as { secret: string }).secret} of a step was not looked up.`);
    }

    // The steps without the secrets' names: the page needs only their values.
    const plain = steps.map((step) => ("secret" in step ? { type: step.type, secret: true, value: step.value } : step));

    return `(() => {
  const steps = ${JSON.stringify(plain)};
  const words = ${JSON.stringify(steps.map(stepWords))};
  const from = typeof window.__piStepsFrom === "number" ? window.__piStepsFrom : 0;
  const state = { state: "running", at: from, resume: from };
  window.__piSteps = state;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const find = (selector) => {
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      throw new Error(JSON.stringify(selector) + " is not a CSS selector");
    }
    if (element === null) throw new Error("nothing matches " + JSON.stringify(selector));
    if (!shown(element)) throw new Error(JSON.stringify(selector) + " matches an element that is not visible (hidden, display none, or 0×0)");
    return element;
  };
  const found = async (selector, ms) => {
    const until = Date.now() + ms;
    for (;;) {
      try {
        return find(selector);
      } catch (error) {
        if (Date.now() >= until) throw error;
      }
      await sleep(100);
    }
  };
  // Before a click or a key, which may load another page: the renderer has read that it counts as done ("seen").
  const told = async (done) => {
    state.resume = done;
    if (state.acks === false) return;
    const until = Date.now() + (state.seen === undefined ? 1000 : 5000);
    while (state.seen !== done) {
      if (Date.now() >= until) {
        if (state.seen === undefined) { state.acks = false; return; }
        throw new Error("the renderer stopped reading how far the steps are");
      }
      await sleep(20);
    }
  };
  const press = (element, type, init) => element.dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }));
  const run = async (step, index) => {
    if ("click" in step) {
      const element = await found(step.click, 2000);
      await told(index + 1);
      const box = element.getBoundingClientRect();
      const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0 };
      press(element, "pointerdown", { ...at, pointerType: "mouse", isPrimary: true, buttons: 1 });
      press(element, "mousedown", { ...at, buttons: 1 });
      if (typeof element.focus === "function") element.focus({ preventScroll: true });
      press(element, "pointerup", { ...at, pointerType: "mouse", isPrimary: true });
      press(element, "mouseup", at);
      element.click();
    } else if ("type" in step) {
      const element = await found(step.type, 2000);
      // A secret shows as dots only in a password field: anywhere else the picture would show it.
      if (step.secret && !(element instanceof HTMLInputElement && element.type === "password")) {
        throw new Error(JSON.stringify(step.type) + " is not a password field: a secret is typed into a password field only");
      }
      const typed = step.secret ? step.value : step.text;
      element.focus({ preventScroll: true });
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set;
        setter.call(element, typed);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: step.secret ? null : typed }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (element.isContentEditable) {
        document.execCommand("insertText", false, step.text);
      } else {
        throw new Error(JSON.stringify(step.type) + " is not a field (an input, a textarea, or an editable element)");
      }
    } else if ("press" in step) {
      await told(index + 1);
      const target = document.activeElement || document.body;
      const init = { key: step.press, code: step.press.length === 1 ? "Key" + step.press.toUpperCase() : step.press, bubbles: true, cancelable: true, composed: true };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    } else if (typeof step.wait === "number") {
      await sleep(step.wait);
    } else {
      try {
        await found(step.wait, 5000);
      } catch (error) {
        throw new Error("nothing visible matched within 5 s: " + error.message);
      }
    }
  };
  (async () => {
    for (let index = from; index < steps.length; index++) {
      state.at = index + 1;
      try {
        await run(steps[index], index);
        state.resume = index + 1;
      } catch (error) {
        state.error = "step " + (index + 1) + " (" + words[index] + "): " + (error && error.message ? error.message : String(error));
        state.state = "failed";
        return;
      }
      await sleep(150);
    }
    await sleep(300);
    state.state = "done";
  })();
  return "started";
})()`;
}

/** Where the steps are, from `STEPS_STATE`'s answer. */
export function parseStepsState(json: string | null | undefined): StepsState | undefined {
    if (json === null || json === undefined || json === "null") {
        return undefined;
    }

    const parsed = JSON.parse(json) as StepsState;

    return typeof parsed === "object" && parsed !== null && typeof parsed.state === "string" ? parsed : undefined;
}
