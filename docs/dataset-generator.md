# Dataset generator design

The dataset generator is a static, browser-only tool at `/dataset`. It is intended for collecting cap photos and linking them to `type_id` values from `static/caps.json`.

## Current MVP

1. User uploads a photo of one cap.
2. The image is drawn to canvas and downscaled.
3. Background color is sampled from image corners.
4. Foreground is detected by color distance from the background.
5. The detected object is cropped into a square normalized image.
6. The circular center area is used to compute:
   - average RGB color;
   - RGB 4x4x4 histogram;
7. New sample is compared against the existing draft.
8. User manually selects or corrects `type_id`, color, and note.
9. Draft is stored in `localStorage`.
10. User exports `dataset.json`.

## Duplicate detection

Average color alone is not enough because two different printed caps can have the same average color. The MVP uses a rotation-stable color fingerprint:

- `average_rgb`: catches obvious color families.
- `histogram_rgb_4x4x4`: catches multicolor distribution differences.

The duplicate score is weighted:

```text
score = normalized_color_distance * 0.30
      + histogram_distance        * 0.70
```

The current implementation uses a nearby weighting of `0.25 / 0.75` in favor of histogram distance. Samples below `0.18` are treated as likely duplicates; samples below `0.32` are shown as similar candidates for human review.

## Recommended next steps

- Add multi-cap batch photo mode: detect several connected components and create several pending samples at once.
- Add manual crop handles for failed automatic crop cases.
- Save exported crop images as separate files when a backend or File System Access API flow is available.
- Replace the current background-distance cropper with OpenCV.js contour detection if photos vary a lot.
- Add radial histograms or polar matching if global histograms become too weak for detailed logos.
- Add ORB/SIFT-like local feature matching later if caps have detailed logos and color-only fingerprints become too weak.
- Track per-`type_id` sample diversity: light angle, rotation, front/side glare, worn/clean states.
