/**
 * Getting started (PP-235): in a person's Getting started session, Pi guides them through pi-phone by the topics they
 * pick, with the `getting-started` skill. The `guide` tool keeps the checklist the person sees under the session's
 * header: the topics picked, each ticked as Pi finishes it, and at the end the session is settled (owner's decision F).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { APP_ROOT } from "../config.ts";
import { GuideDoc, type GuideItem } from "../docs.ts";
import type { PocketHost } from "../host.ts";

/** The extension's name; its module is `onboarding.ts`. */
export const ONBOARDING_EXTENSION = "pocket-onboarding";
/** Where the release notes are, one file a version (`whatsnew/<version>.md`), for the What's new topic. */
export const WHATS_NEW_DIR = join(APP_ROOT, "whatsnew");
/**
 * The screens `show_screen` offers (web/guide.js opens each): the app's own, and Android's that only the pi-phone app on
 * the phone opens (`android-…`, the microphone's question).
 */
export const SCREENS = [
    "providers",
    "default-model",
    "appearance",
    "notifications",
    "dictation",
    "voice",
    "assistant",
    "this-phone",
    "phone-control",
    "computer-control",
    "machines",
    "ssh-keys",
    "secrets",
    "pi-browser",
    "web-access",
    "spend",
    "github",
    "android-notifications",
    "android-battery",
    "android-accessibility",
    "android-app-info",
    "android-default-apps",
    "microphone",
] as const;
/** The most parts a checklist has, and the longest a part's text is. */
const MAX_ITEMS = 12;
const MAX_TEXT = 80;

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
/** The parts as plain values: the document's own cannot be read once its commit is over. */
const copy = (items: GuideItem[]): GuideItem[] => items.map((item) => ({ text: item.text, done: item.done }));
const checklist = (items: GuideItem[]) => items.map((item, index) => `${index + 1}. [${item.done ? "x" : " "}] ${item.text}`).join("\n");

export default function createOnboarding(host: PocketHost) {
    /** Whose Getting started session this is, if it is one. */
    const guideOf = (conversationId: unknown) => host.people().find((person) => host.person(person.id).guide === String(conversationId));

    const guide = defineTool({
        name: "guide",
        description:
            "The checklist of a Getting started session, shown to the person under the session's header (the getting-started skill says when). " +
            "set: the parts to go through, in order (items); tick or untick: one part, by its number from 1 or its text (item); " +
            "finish: the guide is over, and the session is settled (out of the active list; Menu › Getting started opens it again).",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("set"), Type.Literal("tick"), Type.Literal("untick"), Type.Literal("finish")]),
            items: Type.Optional(Type.Array(Type.String(), { description: "set: the parts, a few words each, in the person's language" })),
            item: Type.Optional(Type.String({ description: "tick, untick: the part's number (from 1) or its text" })),
        }),
        // Each action sets the list to a state: doing it again changes nothing more.
        replay: "safe",
        execute: async (args, api, context) => {
            if (args.action === "set") {
                const items = (args.items ?? []).map((text) => text.replace(/\s+/g, " ").trim()).filter((text) => text !== "");

                if (items.length === 0 || items.length > MAX_ITEMS || items.some((text) => text.length > MAX_TEXT)) {
                    throw new Error(`set takes 1 to ${MAX_ITEMS} parts of ${MAX_TEXT} characters at most.`);
                }

                const list = await api.commit(async (tx) => {
                    const doc = await tx.doc(GuideDoc, api.conversationId);
                    // A part kept from the list before keeps its tick.
                    const before = new Map(doc.items.map((item) => [item.text, item.done]));

                    doc.items = items.map((text) => ({ text, done: before.get(text) ?? false }));
                    delete doc.finished;

                    return copy(doc.items);
                }, context);

                return reply(`The checklist:\n${checklist(list)}`);
            }

            if (args.action === "finish") {
                const list = await api.commit(async (tx) => {
                    const doc = await tx.doc(GuideDoc, api.conversationId);

                    doc.finished = true;

                    return copy(doc.items);
                }, context);

                await host.settleSession(Number(api.conversationId), "Getting started is done");

                return reply(`The guide is over and the session is settled. The checklist:\n${checklist(list)}`);
            }

            const wanted = (args.item ?? "").trim();

            if (wanted === "") {
                throw new Error(`${args.action} needs the part's number or its text (item).`);
            }

            const list = await api.commit(async (tx) => {
                const doc = await tx.doc(GuideDoc, api.conversationId);
                const number = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1;
                const index = number >= 0 ? number : doc.items.findIndex((item) => item.text.toLowerCase() === wanted.toLowerCase());
                const item = doc.items[index];

                if (item === undefined) {
                    throw new Error(`There is no part ${wanted}. The checklist:\n${checklist(doc.items) || "(empty: set it first)"}`);
                }

                item.done = args.action === "tick";

                return copy(doc.items);
            }, context);

            return reply(`The checklist:\n${checklist(list)}`);
        },
    });

    const showScreen = defineTool({
        name: "show_screen",
        description:
            "Put a card in the chat with a button that opens one of the app's screens, or one of Android's (in the pi-phone app on the phone), for the person to act there: " +
            "turn on Accessibility for phone control, allow the microphone, sign in to a provider. Nothing opens until they tap it. " +
            "screen: providers, default-model, appearance, notifications, dictation, voice, assistant, this-phone, phone-control, computer-control, machines, ssh-keys, secrets, pi-browser, web-access, spend, github; " +
            "Android's: android-notifications, android-battery (run with the screen off), android-accessibility, android-app-info (Allow restricted settings), android-default-apps (the digital assistant app), microphone.",
        parameters: Type.Object({
            screen: Type.Union(SCREENS.map((each) => Type.Literal(each))),
            why: Type.Optional(Type.String({ description: "What they do there, in a sentence, in their language" })),
        }),
        replay: "safe",
        execute: async (args) =>
            reply(`A card with a button to open ${args.screen} is in the chat. Nothing opens until they tap it: ask them to say when they are done there.`),
    });

    return defineExtension({
        name: ONBOARDING_EXTENSION,
        tools: [guide, showScreen],
        sections: [
            section("getting-started", (input) => {
                const person = guideOf(input.conversationId);

                if (person === undefined) {
                    return undefined;
                }

                return `This is ${person.name}'s Getting started session: you show them around pi-phone. Read the getting-started skill first and follow it: ask what to cover, keep the checklist with the guide tool, change settings only with setting_change and app_action (each asks them on a card), show a screen they must act on with show_screen, and finish with guide finish. Release notes for the What's new topic: ${WHATS_NEW_DIR}/<version>.md.`;
            }),
        ],
    });
}
