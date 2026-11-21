---
name: ketchup-video
description: "Catch the user up like /ketchup, with a short subtitled video of slides for what happened and the waiting calls as text under it. Use for /ketchup-video."
disable-model-invocation: true
---

# Ketchup video

Follow [`/ketchup`](../ketchup/SKILL.md), but show what happened in a short subtitled video instead of its summary and visuals. Its window starts at the last message the user wrote before `/ketchup-video`, not before any earlier `/ketchup`. Writing and rendering the video, outside the repo, is the one exception to its read-only rule. The reply is ketchup's opening sentence, the embedded video, one line naming any work left that you can do yourself, and the action items. When the video shows a call's options, call each option by the name the video gives it. If the render fails, say so in one line and give only the calls.

<!-- pi-phone: added (third_party/pstack/README.md) -->
In pi-phone the video is narrated, and the phone renders nothing:

- **Where.** Render on one of the owner's machines that has the HyperFrames and ffmpeg machine tools. `machine_tools` with action `status` shows which machines have them. Work there with `machine_run` and `machine_copy`, in a scratch folder outside any repository, with `PATH=~/.pi/mobile/tools/bin:$PATH`. Never `npx hyperframes`. With no such machine, say that /ketchup-video needs one, offer the install (`machine_tools` install, on the owner's card), and give ketchup's reply as text.
- **Ask first.** Plan the slides and write every subtitle before you make any sound or picture. Then ask the owner on one `interview` card, a `single` question with the options Render and Not now. Its `context` says what it costs and how long it takes:
  - the machine;
  - the number of slides and the video's length;
  - the voice-over's length, made with `audio_speak` on the owner's ChatGPT sign-in;
  - your estimate of the render time;
  - your session's own model time to build it.

  Make nothing before the owner picks Render. On Not now, give ketchup's reply as text.
- **The voice.** Each slide's subtitle is also its spoken line, in the user's language. Make one `audio_speak` file per slide. Read each file's length with `media` action `info`. A slide's hold is the longer of the reading time below and its line's length plus half a second.
- **The video.** Write the slides as one HyperFrames composition (`hyperframes docs compositions`, `data-attributes` and `gsap`), 1280 by 720.
  - Load GSAP from the tool's own copy, `~/.pi/mobile/tools/hyperframes/<version>/app/node_modules/hyperframes/dist/vendor/npm/gsap@<version>/dist/gsap.min.js`, copied beside `index.html`, not from a CDN. A render must not depend on the network.
  - Use a font the machine has with the user's letters (`fc-list`). Hide things at the start with `gsap.set` outside the timeline, and put `data-hold` on the stage where the stillness is for reading.
  - Run `hyperframes check <folder>` and fix what it finds.
  - Render with `hyperframes render <folder> -o <file>.mp4`.
  - Lay each slide's line in at its slide's start with ffmpeg (`adelay`, `amix`), and mux the result into the video as AAC. The voice never runs past its slide.
- **Show it.** Copy the mp4 into the session's `videos/` folder with `machine_copy`, and embed it in the reply as `![what it shows](videos/<name>.mp4)`. The app plays a video embedded that way. Check the frames with `media` action `frames` (`sheet: true`).
<!-- /pi-phone -->

## Slides

Use the screenshots, recordings, diffs, and data the work produced, not the chat's prose about them. Before you draw, write the one sentence the user should leave with and one line per slide. Drop each slide that does not change what the user knows. Use at most 10 slides, and fewer is better. Neither note goes in the reply.

Each slide makes one point. Build the slides on one picture and change it from slide to slide, rather than cut to an unrelated one. A color or shape means the same thing on every slide. Show the work in pictures, such as how a system works, a PR stack with each PR's state, a before and after of a fix, or options side by side. Point at what changed with arrows, highlights, and motion. A slide is never a bullet list, a status list, a table, or boxes with nothing connecting them.

Keep text to the minimum. Put each label on the thing it names, in plain words a person would say, not tags like "Tests: pass". Never caption what a picture shows, and never give a fact twice, across slides or in the text under them.

Show what came of each thing the user asked for, and whether it is done, still running, failed, or not checked. Never show something done that still waits on the user. Show any bug found and fixed on the way. If a visible change has no screenshot, say so on its slide and name what changed on screen. Draw only from facts you have. Never invent a number, and never draw a screen you did not capture.

## Subtitles

Give each slide one short subtitle line, about ten words, that says its point the way you would tell the user, from only what that slide shows. Say what the picture means rather than read out its labels. Put the subtitle in a strip below the slide, the same height on every slide and empty except for the subtitle, so it never covers the slide. Set it small, but readable when the video plays at chat size.

## Render

<!-- pi-phone: adapted -->Render one narrated landscape mp4, with motion between slides.<!-- /pi-phone --> Every frame is the slide itself, edge to edge, above its subtitle strip. Make the frames from the slides, never by recording a screen, and burn each subtitle into its slide's frames so it stays on screen for the slide's whole hold. The hold is the time a slide is fully on screen, not counting the motion into or out of it. Hold each slide long enough to read the words it adds, at least one second for each three words. A slide adds its subtitle and each word that was not on the slide before it, including a label it changes. The first slide adds all its words. Words inside a screenshot do not count.

Before you embed the video, check the rendered file. Look at one frame from each slide at chat size, and check that its subtitle is readable and covers nothing. Measure each hold by matching the file's frames to the slide, not with a still-frame detector, which counts the faint ends of a fade as still. Count the words each slide adds against its measured hold. Fix any slide you cannot read in that time, render again, and check again.
