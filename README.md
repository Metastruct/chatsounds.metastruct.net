# make-chatsounds

Cut one long recording into named chatsound clips, entirely in the browser.

Drop in an audio or video file. It finds where each voice line starts and ends,
transcribes it, names the clip after what is said, and gives you an editor to fix
what the machine got wrong: trim, extend, split, merge, rename, add one it missed.
Then it hands you a ZIP of `.ogg` files whose names are already legal chatsounds
triggers.

**Scope.** This screen ends at the clips. Getting them into the right folder of the
right repository is a separate job, meant for a separate tab: signing in with GitHub
and opening the pull request. So nothing here asks you to name a pack, choose a base
path, or think about realms, and the zip carries no folder to sit under.

**Nothing is uploaded.** Decoding, voice detection, transcription and Ogg Vorbis
encoding all happen in the tab. The server is an nginx container serving static
files, with no database, no uploads directory and no per-user state, so it
costs the same to host for one person as for a hundred.

Built for [neo-chatsounds](https://github.com/Earu/neo-chatsounds) and
[garrysmod-chatsounds](https://github.com/Metastruct/garrysmod-chatsounds).

---

## Quick start

```bash
docker compose up -d --build
```

Then open <http://localhost:8080>.

The speech model downloads on first use (~80 MB for the default) and is cached by
the browser afterwards.

> **Serve it over HTTPS.** Browsers only grant `SharedArrayBuffer`, and with it
> multi-threaded WebAssembly, to [cross-origin isolated](https://web.dev/articles/coop-coep)
> pages, which requires a trustworthy origin. Over plain HTTP on a LAN address
> everything still works, just single-threaded and several times slower.
> `localhost` counts as trustworthy; `192.168.x.x` does not.

---

## Why the output looks the way it does

In chatsounds the **filename is the trigger phrase**, so the whole job is really
"name these clips correctly". `neo-chatsounds` derives the trigger from the path:

```lua
key = chunk:lower():gsub("%.ogg$", ""):gsub("[%_%-]", " "):gsub("[%s\t\n\r]+", " "):Trim()
```

and the chat parser only strips `"` and `'` from what a player types. A trigger
containing any other punctuation is therefore unreachable: the filename keeps
the character, the typed message loses it, and they never match. So the app
strips punctuation up front, and everything it writes obeys:

| Rule | Why |
| --- | --- |
| `.ogg`, Vorbis | the modern loader ignores every other extension, and GMod plays these through BASS, which needs a plugin for Opus |
| 44.1 kHz, mono, `-q:a 3` equivalent | the spec in the addon's `HOW TO ADD SOUNDS.txt` |
| all-lowercase paths | the legacy preprocessor rejects non-lowercase paths outright |
| `[a-z0-9 ]` triggers only | anything else cannot be typed into chat and matched |
| variations numbered `01`, `02`, … | the addon orders variations by URL, so `1, 10, 2` would shuffle `:select(n)` |
| never emits `sh` | reserved by the addon for stopping playback |

A name used once stays a flat file. The moment two clips share a name, both move
into a folder and become numbered variations, which is exactly how the addon models
"pick one of these", and is also the only way two clips can share a name at all:

```
hello there.ogg
get down/01.ogg
get down/02.ogg
```

That is the whole zip. No `sounds/chatsounds/<pack>/` prefix, no index files, no
`repo_config.json` snippet to copy by hand.

**Why nothing above the clips.** Every one of those needs to know which repository
this is going to, and that is the publish step's business, not this screen's. The
prefix, the `repo_config.json` line, and the two optional index files
(`list.msgpack` and the legacy `lua/chatsounds/lists_nosend/<realm>.lua`, both keyed
by realm) all came from a version of this page that tried to do the publishing on
your behalf by telling you how. They have been removed rather than left switched
off; a publish flow that has a GitHub token can regenerate any of them from the
clip list, correctly, without asking.

> The app has no concept of realms or speakers. It segments per voice line, and
> stops there.

---

## How it works

```
file ─► decodeAudioData ──► OfflineAudioContext ─┬─► 16 kHz mono ──► silero VAD ──► speech intervals
        (main thread, native)                    │                └─► Whisper ──► word timings
                                                 └─► 44.1 kHz mono ──► every clip is cut from here
                                                        │
                    segmenter: VAD intervals ∩ word timings ──► voice lines
                                                        │
                    naming: transcript ──► trigger ──► collision-resolved paths
                                                        │
                                       libvorbis (WASM) ──► .ogg ──► zip
```

Neither detector is sufficient alone. Silero knows precisely *where* speech is
but nothing about what it says; Whisper knows the words but its segment
boundaries routinely glue two lines together or cut mid-word. So silero's
intervals are the skeleton, Whisper's words hang off them, and the word timings
are used only to decide where an over-long interval should be broken, at its
most balanced internal pause. Boundaries are then snapped to the nearest local
energy minimum, so cuts land in silence rather than clipping a syllable.

Because word timings are *estimated* while VAD boundaries are *measured*, a word
may nudge a boundary by at most 250 ms. Without that cap one mistimed word
stretches its line across the silence and swallows the next one, which is
exactly the difference between `hello` / `there i am a doctor` and the correct
`hello there` / `i am a doctor`.

A few consequences worth knowing:

- **Editing is instant.** Clips are cut from the decoded master already in
  memory, so dragging a boundary never re-decodes anything. A clip is encoded
  lazily, on first play or export, and cached by a key derived from its bounds,
  gain and quality, so moving a boundary back reuses the previous render.
- **Playback is instant too.** The editor plays time ranges of the master rather
  than a file per clip, which is also what makes previewing an *extended* clip
  possible: the audio outside the current bounds is already there.
- **Long files stay cheap to draw.** The waveform comes from a precomputed 200 Hz
  envelope, so a 90-minute recording draws as fast as a 10-second one, and the
  zoomed clip editor slices that same envelope at 5 ms resolution.

### Notable constraints

- **Everything is held in memory.** A 90-minute recording is roughly 500 MB of
  decoded audio once resampled. Minutes-long voice-line dumps are the intended
  case; feature-length files will strain a tab.
- **A reload loses the work.** There is nowhere to save it to; the app leaves a
  breadcrumb naming the last file you worked on and asks you to open it again.
- **mkv and avi cannot be decoded by any browser.** The app says so and tells you
  the one-line ffmpeg remux to run. mp4/m4a/mov depend on AAC being available:
  Chrome and Edge ship it, Firefox borrows it from the system, and Chromium builds
  without proprietary codecs do not have it. When the decode fails the app hands
  you the ffmpeg line for that too.

---

## The editor

The overview timeline is the main instrument, not a picture of one:

| Gesture | |
| --- | --- |
| click a clip | select it |
| drag its edge | trim or extend it |
| drag empty space | **add a clip** |
| click elsewhere | play from there |

A clip drawn by hand has no words behind it, so it is snapped to the nearest quiet
points and then transcribed on its own straight away. A clip with no name is the one
thing here of no use at all, and the same one-clip transcription is what names the
second half after a split.

Everything else the panel used to offer as a button is either a gesture now or a
key. Two dozen nudge buttons said less than dragging the edge does:

| | |
| --- | --- |
| <kbd>space</kbd> | play the selected clip |
| <kbd>j</kbd> / <kbd>k</kbd> | next / previous clip |
| <kbd>[</kbd> <kbd>]</kbd> | move the start ±50 ms |
| <kbd>{</kbd> <kbd>}</kbd> | move the end ±50 ms |
| <kbd>n</kbd> | add a clip at the playhead |
| <kbd>s</kbd> | cut in two at the playhead |
| <kbd>m</kbd> | join to the next clip |
| <kbd>x</kbd> | delete |
| <kbd>enter</kbd> | rename |

What is left in the toolbar is adding a clip, searching, and the download. The
bulk operations that were there (filter to the flagged ones, delete them all,
match every clip's loudness) are gone: three buttons crowding out the two that
matter. Clips the segmenter was unsure about still carry a tag, `no words`, `long`
or `short`, since `no words` is how you spot one that still needs a name, and
per-clip volume is still a slider.

The zoomed view beside the list stays, because on a ninety-minute recording a
two-second clip is two pixels wide and there is nothing to grab on the overview.
Same gestures, one clip at a time.

---

## Models

Whisper runs through [transformers.js](https://github.com/huggingface/transformers.js).
Four sizes are offered; **base** is the default.

| Model | Download | Notes |
| --- | --- | --- |
| tiny.en | ~40 MB | fastest, noticeably worse triggers |
| base | ~80 MB | the default |
| small | ~250 MB | better, wants WebGPU |
| large-v3-turbo | ~800 MB | best, effectively WebGPU-only |

All four are the **`_timestamped`** exports specifically. Word-level timestamps
come from Whisper's cross-attentions, and a model has to be exported with
`output_attentions=True` for those to exist in the graph at all. The plain ONNX
exports fail outright when asked for word timings, which would take the
segmenter's basis for splitting long lines with them.

WebGPU is used when available and WebAssembly otherwise. The WASM path works but
is several times slower; the upload screen says so when it detects no WebGPU, and
names the setting to change for the browser you are actually using.

> **Firefox.** WebGPU is on by default on Windows only. On Linux and macOS it is
> still behind `dom.webgpu.enabled` in `about:config`, and a restart. Nothing the
> page does can turn it on. `about:support` reports what the graphics stack
> settled on.

### Which backend, and what happens when it fails

**Runs on** in the detection settings is *automatic*, *WebGPU (force)* or
*WebAssembly (CPU)*. Automatic takes the GPU wherever it can, except Firefox,
where it grants an adapter and loads the model and then fails partway through
inference inside onnxruntime's own buffer manager:

```
failed to call OrtRun(). ERROR_CODE: 1 … webgpu/buffer_manager.cc:553
Failed to download data from buffer: Mapping WebGPU buffer failed: Invalid buffer
```

Whisper is where that surfaces, being the only model here big enough to reach it.
Forcing WebGPU still tries: the implementation moves quickly and this is a
preference, not a lockout.

Any failure during transcription is then walked down a short ladder, each rung a
real attempt on the same audio: **GPU → CPU quantised → CPU full precision**. The
last is the combination nothing has been observed to reject, and also the largest
and slowest, hence last.

Each rung needs a **fresh worker**, and that is not an optimisation. It is the
mechanism. transformers.js funnels every session creation and every inference
through a promise chain it never clears:

```js
return apis.IS_WEB_ENV ? webInferenceChain = webInferenceChain.then(run) : run()
```

With no rejection handler, the first failure leaves that chain rejected forever,
and every later call returns the same error without running anything. So a retry
in the same worker is not slow, it is impossible, which is also why the app used
to report the *first* dtype's error after appearing to try a second. The store
therefore terminates the worker, rebuilds the 16 kHz working audio from the
master (it was transferred, not copied), and starts over, saying so on the
progress screen rather than silently rewinding the stage list.

Weights are fetched from the Hugging Face CDN and cached by the browser. That is
the one third-party request the app makes. Everything else, including the fonts
and the VAD model, is served from your own origin. To remove it entirely, mirror
the model files and point `env.remoteHost` in `src/pipeline/asr.ts` at your copy.

### onnxruntime and its WebAssembly

Both the VAD and Whisper run on onnxruntime-web, and `src/pipeline/ort.ts` exists
to make sure that is *one* runtime with its binary on our own origin. Two things
go wrong otherwise, and both surface as the same message, **"no available
backend found. ERR: \[wasm] … failed to match magic number"**:

- onnxruntime locates its `.wasm` by resolving the filename against the module
  that loaded it, which under a bundler is a path nothing serves. The dev server
  answers it with `index.html`, which then fails to compile as WebAssembly.
- transformers.js, finding the path unset, points it at jsdelivr, turning a
  binary we already ship into a 23 MB third-party download.

So `ort.ts` names both files explicitly, as URLs Vite emits as assets, and picks
the pair that matches the backend in use: the `asyncify` build (23 MB) can drive
WebGPU, while the plain build (13 MB) is CPU-only and is what a browser without a
GPU is given. `onnxruntime-web` is also pinned in `package.json` to the exact
build transformers.js depends on, and forced on it via `overrides`, because two
copies means two `env` objects: configuring one leaves the other on the CDN.
**Bump that pin whenever transformers.js is bumped.**

---

## Development

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173
npm test        # 100 unit tests
npm run build
```

The tests cover the parts that have to be exactly right: the trigger rules
(including a round-trip through a reimplementation of the addon's own key
derivation, so the names written to disk survive what the loader does to them),
the segmenter's boundary and splitting logic, the envelope reader, the zip layout,
where a hand-drawn clip is allowed to land, that onnxruntime is told where both
halves of its WebAssembly are, and that the backend fallback ladder always
terminates.

### Layout

```
frontend/src/
├── pipeline/     decode · vad · asr · segmenter · naming · encode · pack
│                 plus gpu (is there a WebGPU adapter, and why not), ort (where
│                 onnxruntime finds its own WebAssembly) and attempts (what to
│                 try next when the backend fails)
├── workers/      the VAD/ASR/encode worker -- Web Audio is main-thread only,
│                 so decoding stays outside it and everything else moves in
├── store/        job state, worker client, IndexedDB breadcrumb
├── components/   upload · processing · editor · waveform · clip editor
└── styles/       design tokens taken from metastruct.net
```

---

## Design

The interface follows [metastruct.net](https://metastruct.net): its navbar and
logo, a `#212121` page with `#171717` chrome and `#4a4a4a` panels floating on a
single soft dark halo, Open Sans at a 14px root, and a two-accent system that is
the load-bearing idea: teal `#09b387` means *you can act on this*, purple
`#7d3b80` means *you are interacting with this*. In the segment list that
distinction does real work. Open Sans is self-hosted and the icons are inlined
MDI paths, so the page itself pulls nothing from a CDN.

### Three control heights, and no fourth

Every button, input, select and tag takes its height from `--control-h` (2.5rem),
`--control-h-sm` (2rem) or `--control-h-xs` (1.5rem, tags only). **In rem, never em.**

That last part is the whole point. These heights used to be written in `em`, which
makes a height a function of the element's own font size, so every variant that set
smaller type silently got a smaller box: `.button.is-small` at `0.85rem` came out
23.8px rather than the 28px it read as, an icon button whose glyph was set to
`0.75rem` came out 26px, and the download button beside it came out 24px. Seven
controls, six heights, none of them chosen. A variant may change the type size; the
box comes from the token.

The scale means: **2.5rem** for a control standing on its own or in a form, **2rem**
for dense rows and toolbars, where every control in one row shares a height,
**1.5rem** for tags. An `is-icon` button is a square of its own height whatever the
glyph inside is sized at.
