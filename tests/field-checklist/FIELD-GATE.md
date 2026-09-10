# FLOWVISION — mandatory physical field gate

Specification §21. Automated tests do **not** substitute for this. A green test
suite and a working web preview prove nothing about physical Android behaviour.

## Pass criterion

**20 consecutive** complete runs on a physical Android device with:

- no crash,
- no lost measurement,
- no camera startup failure,
- no unexplained blank screen.

Any failure resets the consecutive count to zero. Restart counting only after
the cause has been identified and fixed.

Until this gate passes, Live Flow development stays paused: no lifecycle work,
no continuous recording (§19).

## One run

Repeat all ten steps in order. Record the result of each.

| # | Step | Pass condition |
|---|------|----------------|
| 1 | NEW MEASUREMENT, same saved site | Site geometry loads; depth is empty and asks to be measured |
| 2 | Confirm geometry, enter the current depth | Impossible values blocked with a reason; unusual values need an explicit confirmation |
| 3 | Velocity → Video → open VIDEO VELOCITY | Screen opens with the EXPERIMENTAL badge visible |
| 4 | Camera preview | Preview appears; `CAMERA READY` shown before recording is allowed. No blank screen at any point |
| 5 | Record a clip (or, on the runs designated for it, import one from the gallery) | Video is written to permanent app storage, size > 0, and the stored size is displayed. A cancelled import is reported as cancelled, not as an error |
| 6 | Place ROI points 1–4, enter the known width and length | Calibration status reads VALID; every ROI problem is named in plain language |
| 7 | Run the SSIV analysis | Either a result with accepted/total, acceptance %, camera compensation, Vsurface, α and Q — or exactly one of the five failure categories with its corrective action and technical detail |
| 8 | Save, leave the screen, reopen the saved record | The record is present after reopening, with the same numbers |
| 9 | Inspect the original video and the processing metadata | The stored clip still plays; RAW DATA shows the vectors and their metrics |
| 10 | Export PDF and CSV | Both files are produced locally and reach the chosen folder through the Android system chooser / SAF |

## Log

| Run | Date | Device / Android | Site | Outcome | Notes |
|-----|------|------------------|------|---------|-------|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |
| 8 | | | | | |
| 9 | | | | | |
| 10 | | | | | |
| 11 | | | | | |
| 12 | | | | | |
| 13 | | | | | |
| 14 | | | | | |
| 15 | | | | | |
| 16 | | | | | |
| 17 | | | | | |
| 18 | | | | | |
| 19 | | | | | |
| 20 | | | | | |

## Runs to vary deliberately

Spread these across the 20 runs rather than repeating one easy case:

- gallery import instead of recording (at least 3 runs);
- a genuinely textureless water surface, to confirm INSUFFICIENT TEXTURE appears
  rather than a number;
- a deliberately shaky hand-held clip, to confirm UNSTABLE CAMERA;
- an ROI with the corners entered in the wrong order, to confirm the calibration
  is refused;
- a first-install run where the camera permission is granted on the first tap,
  to confirm the flow continues without a second tap;
- a run with the camera permission permanently blocked in Android settings, to
  confirm the app offers the settings shortcut;
- RETRY VIDEO MEASUREMENT on a saved record, to confirm the original record is
  unchanged until a new measurement is explicitly saved.
