# Step 1 report: can the iPhone mic hear the CT-S1 well enough?

**Short answer:** In a realistic simulation, yes. It meets the single-note, chord and delay targets in a quiet room and with a fan running. The only weak spot is a TV or someone talking nearby. **This is a pre-test, not the final answer:** the final answer comes from running these same tests on Bivi's 7 recordings (see `RECORDING-SCRIPT.md`).

## What was built
| Piece | File | What it does |
|---|---|---|
| Listener | `dsp/listener.js` | Expected-note matching for single notes and chords, plus the McLeod Pitch Method (MPM) to identify wrong notes. No dependencies. |
| AudioWorklet | `web/processor.src.js` → `web/piano-listener.worklet.js` | Runs the listener on the audio thread, 128 samples at a time. Bundled into one classic script, so it doesn't rely on module imports in Safari worklets. |
| Mic setup | `web/mic.js` | Opens the mic with echo cancellation, noise suppression and auto gain **off**, and connects it to the worklet. |
| Test set | `eval/synth.mjs` | Builds the recording script's 7 takes from real grand piano samples (Salamander, Yamaha C5), with simulated small speakers, room echo and noise. |
| Scorer | `eval/run.mjs` | Hit rate, wrong-note acceptance, held-note re-triggers, false notes in silence, delay. |
| Listener Lab | `lab/` | A page that runs the detector on demo recordings, your own recordings, or the live mic. |
| Importer | `eval/import-real.mjs` | Takes Bivi's Voice Memos files, finds every strike, labels it from the script, and checks the labels by pitch. |
| Browser test | `web/browser-test.cjs` | Runs the real AudioWorklet in Chromium with a recording fed in as the mic. |

## Results (held-out set: scored once, after all tuning)
The held-out takes use a different random seed, a smaller simulated speaker (200 Hz cutoff), more echo (0.5 s) and noise 4 dB louder than the takes used for tuning.

| Room | Single notes (target 95%) | Chords (target 85%) | Wrong semitone accepted | Wrong octave accepted | Wrong chord accepted | Held note re-triggers | Delay median / worst p90 (target <150 ms) |
|---|---|---|---|---|---|---|---|
| Quiet | **98.2%** (162/165) | **100%** (45/45) | 0.0% | 1.5% | 3.0% | 0.0% | 51 to 66 / 79 ms |
| Fan on | **95.8%** (158/165) | **93.3%** (42/45) | 0.0% | 2.4% | 1.1% | 0.0% | 53 to 67 / 108 ms |
| TV voice | **95.2%** (157/165) | **93.3%** (42/45) | 0.6% | 3.9% | 11.1% | 13.9% | 52 to 65 / 120 ms |

"Held note re-triggers": the target is a note, it is accepted, and the next target is the same note (like Twinkle's C-C). Any accept before the key is pressed again counts as the app advancing on its own.

- **Notes from C3 to C6** (where beginner and intermediate songs live): **97.2%** (411/423). Outside that range: 90.3% (the very top notes B6 and C7 are the weakest).
- **False notes with nobody playing:** quiet room 0 per minute, fan + table taps 0 per minute, **loud TV voice 8 per minute**.
- **In the browser:** the real AudioWorklet in Chromium completed **29/29** scale notes and **45/45** chords in wait mode, at a 44.1 kHz sample rate (iPhone uses 48 kHz; both work).
- **As a Voice Memos file:** after AAC compression and automatic labeling, results matched the held-out set (chords 93%, loud notes 100%, scale 97%), and the importer placed strikes within about 20 ms of the truth.
- **Processing cost:** 2.7% of one CPU core.

Delay is measured from the true key strike to when the app accepts the note. On the phone, add the iPhone's own audio input delay (usually 10 to 20 ms); the on-device test will measure it.

## How it got there (what each test round changed)
| Round | Problem the numbers showed | Fix |
|---|---|---|
| 1 | Single notes 0%, wrong chords 100% accepted | Find each peak's exact centre: a semitone is narrower than one frequency slot below 400 Hz |
| 2 | Octave confusions up to 90% | Ignore small leakage peaks that strong notes spread nearby |
| 3 | Room noise scored 25 dB "above the floor" | The noise floor was tracking dips; now it tracks the average |
| 4 | Thresholds were guesses | Set them from measured distributions (`eval/diag*.mjs`) |
| 5 | TV voice triggered notes | Single notes must hold their pitch for about 10 ms (voices glide, strings don't) |
| 6 | Chords about 50% | That pitch check is for single notes only; relaxed octave check in chords |
| 7 | Playing an octave lower accepted up to 24% | Check 3 "in-between" harmonics instead of 2 |
| 8 | Found in the Listener Lab: a held note could count as the next identical note | Strikes are detected from absolute loudness, a note must get louder than its last 250 ms, and a repeated note needs a key release first |
| 9 | That made soft notes vanish under a TV | For a new pitch (no repeat risk) a quick jump also counts |

## Known weaknesses
1. **TV or conversation nearby:** 8 false notes per minute, 11% wrong chords accepted, and a held note can re-trigger a repeated target 14% of the time. Plan: show "It's a bit noisy, can you turn the TV down?" when the app hears speech-like sound.
2. **Soft low-middle notes with a fan on** (C#3 to A#3): about 89%. Bivi's recordings will show whether this matters in her room.
3. **Soft notes played an octave lower** with a fan on: accepted 13% to 16% of the time. Low impact (right note name, wrong octave).

## Limits of this pre-test (why her recordings are still required)
- The samples are a **Yamaha acoustic grand**, not the CT-S1. The CT-S1's speakers and tone are simulated, not measured.
- The **iPhone mic and Safari's audio path** are not in this test. Voice Memos records with little processing; Safari may still process audio slightly even with the settings off.
- The **TV voice** is synthetic. A real TV is messier.

## Decision rule
After running her 7 recordings through `eval/import-real.mjs` and `eval/run.mjs`:
- **Single notes 95% or more, chords 85% or more, worst p90 delay under 150 ms** → continue with the mic web app.
- **Otherwise** → propose the cable. iPhone browsers can't read USB MIDI, so that means a native app: a USB-C to USB-B cable (CT-S1 to iPhone 16) and TestFlight ($99/year). MIDI is exact: 100% notes and chords, no noise problem.

## Reproduce
```
node eval/synth.mjs                                   # tuning takes
SEED=2024 HP=200 RT=0.5 NOISE_OFFSET=4 OUT=takes_heldout node eval/synth.mjs
node eval/run.mjs takes_heldout                       # the numbers above
node eval/import-real.mjs <folder-with-memos> takes_real && node eval/run.mjs takes_real
node web/build.mjs && node web/browser-test.cjs scale
```
(Piano samples: download Salamander `A/C/Ds/Fs` octaves 1 to 7 from tonejs.github.io/audio/salamander into `samples/` and decode to 48 kHz float32.)
