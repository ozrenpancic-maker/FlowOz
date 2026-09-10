# FLOWVISION

Offline-first Android field application for estimating water flow in pipes and
open channels. The operator defines the geometry of a measurement site, enters
or measures the water depth, chooses a velocity method, and gets a discharge
with every source, quality grade and warning visible alongside it.

Built to the specification *FLOWVISION — kompletna specifikacija* (reference
implementation 1.0.6, Android versionCode 7). This is an independent
implementation of that specification, not a port of the original source.

> **This is an engineering field tool under development.** FLOWVISION produces
> field estimates. It is not metrologically validated, it has no validated
> uncertainty model, and the video workflow is experimental. Those statements
> are carried in the app, in the reports, and in the code.

## What it does

| Method | How the velocity is obtained |
|--------|------------------------------|
| Manning | Estimated from geometry, hydraulic gradient and roughness |
| Manual | Mean velocity entered by the operator |
| Video (experimental) | Local SSIV / cross-correlation of a short clip, scaled by known ROI dimensions |
| Live Flow | **BETA / UNDER DEVELOPMENT** — preserved, not developed (see below) |

Supported cross-sections: circular pipe, rectangular channel, and trapezoidal
channel with independent left/right side slopes (given as a ratio, an angle from
the horizontal, or a wetted side length). Input in mm / cm / m; every internal
computation is in SI.

Everything is local. Sites, measurements, videos, photos, calibrations and
reports stay on the device. Nothing is uploaded, and an export leaves the device
only through an explicit action and the Android system chooser or the Storage
Access Framework.

## The priority workflow

`NEW MEASUREMENT → VIDEO VELOCITY` is the critical path, and it is built to fail
loudly rather than quietly:

1. Camera permission is requested on the operator's tap, and if it is granted on
   that tap the flow continues without a second one. Denied and permanently
   blocked are different messages with different remedies.
2. `CameraView` reports `onCameraReady` before recording is allowed;
   `onMountError` produces **CAMERA STARTUP FAILED** with the underlying detail.
3. Video: rear camera, 720p, **no audio**, 3 / 5 / 10 s, ~80 MB cap. Gallery
   import is equally supported; a cancelled import is a choice, not an error.
4. The clip is copied into permanent application storage and the copy is
   verified to exist and to be non-empty before the draft records it.
5. A four-point ROI is placed in normalised coordinates, with the physical width
   across the flow and length along it. **Known ROI dimensions are the only
   supported metric scale — there is no pixel-scale fallback.**
6. The homography is validated (point bounds, area, winding, self-intersection,
   edge ratio, determinant, round-trip closure) and reported as VALID / POOR /
   INVALID. A metric velocity is computed only for VALID.
7. SSIV runs locally: frames are decoded in an off-screen WebView canvas at 240 px
   working width, six frame pairs, camera motion removed on the stationary part
   of the frame, a 4 × 5 interrogation grid per pair, normalised
   cross-correlation with sub-pixel refinement and a reverse match, then robust
   median/MAD filtering.
8. Every failure lands in exactly one of five categories: INSUFFICIENT TEXTURE,
   INSUFFICIENT VALID VECTORS, INVALID ROI CALIBRATION, VIDEO DECODE FAILURE,
   UNSTABLE CAMERA — each with a corrective action and the technical detail.
9. `RETRY VIDEO MEASUREMENT` re-processes the same stored original video, keeping
   site, geometry, depth, ROI and scale. The saved record it started from is not
   modified until the operator explicitly saves a new measurement.

### SSIV thresholds

Taken from the reference implementation (§11.5), exported as one frozen object
so the UI, the report and the tests all quote the same numbers:

| Check | Threshold |
|---|---|
| Minimum correlation | 0.55 |
| Minimum peak ratio | 1.015 |
| Maximum uncertainty | 20 px |
| Maximum forward/backward inconsistency | 1.5 px |
| Minimum spatial coherence | 0.25 |
| Minimum accepted vectors | 4 |
| Minimum stabilisation correlation | 0.55 |
| Minimum stable pairs | 3 of 6 |

## Sources, quality and uncertainty

Three separate concepts, never collapsed into one badge:

- **Provenance** — SITE, ENTERED, MEASURED, MEASURED (VIDEO), ASSUMED,
  CALIBRATED, CALCULATED, ESTIMATED.
- **Quality** — A / B / C / INVALID for geometry, level and velocity plus an
  overall grade, each with a stated reason. Video velocity never reaches A;
  camera-assisted level is capped at B.
- **Uncertainty** — reported as `UNCERTAINTY NOT YET CALCULATED`. There is no
  validated propagation model, so no number is invented.

Physically impossible values block the calculation. Unusual but possible values
require the operator to confirm them and are kept exactly as entered — nothing
is silently clamped or rounded.

A withheld result is never rendered as `0`: it is WITHHELD on screen, WITHHELD in
the PDF, and an empty cell in the CSV.

Alpha (`Vmean = α · Vsurface`) is a site property — a default assumption or a
site calibration from `α = Qref / (A · Vsurface)` — never a universal constant,
and it travels with every result and every report. Calibration points whose alpha
falls outside the physically defensible band are stored as invalid with a reason
and never move the active alpha.

## Project layout

Pure mathematics is kept away from the UI and from native APIs; camera, decoder
and storage adapters return typed results or typed errors.

```
app/          expo-router screens (home, measure, video, level-camera,
              sites, saved, calibration, validation, settings, live-flow)
domain/       units, geometry, hydraulics, plausibility, quality, calibration,
              ellipse, gps, measurement, draft, linalg — no native imports
video/        roi, homography, ncc, stabilisation, ssiv-core, frame-plan,
              decoder-adapter, decoder-html, failure-taxonomy
storage/      repository, migrations, document-store, sqlite-store,
              media-storage, settings, serialization
reports/      report-model, pdf, csv, android-share
state/        settings-context, measurement-context, gps-capture, i18n (en/hr)
ui/           theme, components, RoiEditor, SsivProcessor, ErrorBoundary
tests/        domain, video, storage, reports, i18n, field-checklist
```

Storage is a versioned local SQLite document store. Writes are queued so two
screens cannot interleave a save; each write snapshots the last committed payload
first, so a corrupt row is recovered rather than losing a field measurement.
React state is updated only after a write has committed. Media files are
reference-counted, so deleting one measurement never removes a video another
record still points at.

## Running it

```bash
npm install
npm run android      # development build on a connected device
npm test             # automated suite
npm run typecheck
```

A native Android build needs a prebuild (`npx expo prebuild -p android`) and then
Gradle or EAS. Reference build settings: package `com.flowvision.field`,
minSdk 24, compile/target SDK 36, portrait, arm64-v8a for the field APK.

The web target exists for inspecting data only. It runs on an in-memory store and
proves nothing about physical Android behaviour.

## Tests

199 automated tests covering SI conversions and all three cross-sections, the
Manning / alpha / Q formulas and the plausibility limits, the robust ellipse fit,
synthetic SSIV displacements with noise and repeatability, homography validity
and degeneracy, the SSIV failure taxonomy and the raw-vector metadata contract,
migrations, serialised writes, restart persistence and backup recovery, PDF/CSV
format and escaping with deterministic file names, GPS classification and
Haversine, and EN/HR translation completeness.

They are not the acceptance criterion. **`tests/field-checklist/FIELD-GATE.md`
is**: 20 consecutive complete runs on a physical Android device with no crash, no
lost measurement, no camera startup failure and no unexplained blank screen.

## Live Flow

Preserved as **LIVE FLOW – BETA / UNDER DEVELOPMENT**, with every result labelled
**LIVE FLOW – EXPERIMENTAL / NOT PHYSICALLY VALIDATED**. The concept (live level
via rating curve, repeated SSIV windows, ECO/BALANCED/HIGH ACCURACY profiles,
rolling statistics, transverse profile, strip discharge, scene reference,
auto-pause on movement, health monitoring, sessions) and any stored session data
are kept. Its lifecycle and continuous recording are deliberately not developed
until the single-video field gate passes.

## Known limitations

- SSIV cross-correlation is experimental and is **not** a validated LSPIV
  implementation.
- There is no completed traceable physical validation against a certified
  reference instrument.
- There is no validated uncertainty budget and no uncertainty propagation.
- Camera lens distortion, pose and perspective are not fully calibrated for a
  metrological claim. Camera-assisted level uses an affine rim model; a small
  residual does not prove perspective accuracy.
- Alpha must be treated as assumed or site-calibrated, never as universally
  correct.
- Live Flow is not ready for production-critical use.
- A web preview does not prove physical Android behaviour.
