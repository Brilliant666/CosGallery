---
title: Media Processing
description: Supported formats, derivative generation rules, and video playback strategy in Foldergram.
---

# Media Processing

> 底层媒体参考：本页介绍继承的解码与派生行为。CosGallery 的身份与入库流程见[本地入库与审核](local-admission-web.md)。受限 JPEG 的原件保留不是成功解码；PDF 附件也不会变成普通图片。媒体生成与资源目录数据库编目是不同工作。

Foldergram generates derivatives so feed and detail views can stay fast without
touching original files on every request. Depending on configuration, those
derivatives are either created during scans or lazily on first request and then
cached on disk.

## Supported formats

### Images

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.gif`
- `.avif`

### Videos

- `.mp4`
- `.mov`
- `.m4v`
- `.webm`
- `.mkv`

## Output sizes

These values are defined in `server/src/utils/image-utils.ts`.

| Constant | Value | Used for |
| --- | --- | --- |
| `THUMBNAIL_SIZE` | `640` | Feed cards, folder grids, avatars, and video posters |
| `PREVIEW_MAX_WIDTH` | `1500` | Detail-view previews and transcodes |

## Derivative timing

`DERIVATIVE_MODE` controls when missing derivatives are created:

| Mode | Behavior |
| --- | --- |
| `eager` | Scans queue derivative generation during indexing. |
| `lazy` | Scans index metadata only. Missing thumbnails and previews are generated when `/thumbnails/...` or `/previews/...` is first requested. |

Lazy mode still writes the generated files to the configured derivative
directories, so subsequent requests use the cached file on disk. It also uses
the same media-specific generation rules as eager mode, including animated AVIF
preview generation.

## Scan-time media failures

`SCAN_MEDIA_ERROR_MODE` controls what happens when supported media reaches scan
processing but fails during stat, metadata, derivative generation, or
derivative-repair work.

| Mode | Behavior |
| --- | --- |
| `skip` | Report the failure, skip that file, continue scanning, and finish the run as `completed_with_errors`. |
| `fail` | Stop on the first such failure and mark the run as failed. |

In skip mode, Foldergram keeps a short admin-visible sample in SQLite and
writes the full per-run report under `<DATA_ROOT>/scan-errors/`.

This applies to supported image and video files that actually reach scan
processing. Unsupported extensions are still ignored earlier during discovery.

## Derivative mapping

Foldergram stores derivatives by stable asset key, not by source-relative path.
Thumbnails and previews share the same shard layout so a media item keeps the
same derivative location even when its source folder path changes.
The current layout uses a single shard segment based on the first two hex
characters of `asset_key`.

| Source media | Thumbnail output | Preview output |
| --- | --- | --- |
| Image | `.webp` | `.webp` |
| Video | `.webp` | `.mp4` or direct original playback |

Examples:

| Source | Thumbnail | Preview |
| --- | --- | --- |
| `trips/oslo/IMG_0001.jpg` | `ab/abcd1234....webp` | `ab/abcd1234....webp` |
| `trips/oslo/clip-01.mov` | `ef/ef01abcd....webp` | `ef/ef01abcd....mp4` |

Existing libraries are migrated in place on the next full scan after upgrade.
Old mirrored derivative paths keep working until that migration completes. If a
stored derivative path points at a missing file during the upgrade, Foldergram
keeps the last known-good path until the new target is repaired or regenerated.

## Image derivatives

Most images are processed with Sharp. Static AVIF files also stay on the Sharp path so transparency and regular image behavior are preserved.

### Thumbnail

- auto-rotated
- resized to width `640` without enlargement
- encoded as WebP with `quality: 82`

### Preview

- auto-rotated
- resized to width `1500` without enlargement
- encoded as WebP with `quality: 86`

## Animated AVIF handling

Animated AVIF image sequences are treated as images in the UI, not videos.

Foldergram uses:

- Sharp first for normal static AVIF image metadata
- `ffprobe` to identify animated AVIF image sequences when Sharp cannot decode them reliably
- `ffmpeg` to generate static WebP thumbnails and animated WebP previews for animated AVIF files

This hybrid path keeps static AVIF on the normal Sharp image pipeline while still supporting animated AVIF sequences that Sharp cannot decode reliably in the current runtime.

Existing libraries with already indexed AVIF files receive a one-time AVIF
metadata repair on the next successful full scan after upgrade. That pass
refreshes legacy animated flags and AVIF timestamp fallbacks for stored rows,
then stops re-reading unchanged AVIF files on later scans.

## Image detail source

`IMAGE_DETAIL_SOURCE` affects image detail pages only:

| Value | Behavior |
| --- | --- |
| `preview` | `/image/:id` uses the generated preview asset. |
| `original` | `/image/:id` uses `/api/originals/:id` for images. |

This setting does not change feed cards, folder grids, avatars, or any video
playback behavior.

## Video metadata

Videos are probed with `ffprobe`.

Foldergram reads:

- width and height
- duration
- creation timestamps when present
- container and codec details used to decide playback strategy

## Video thumbnail generation

Video thumbnails are generated with `ffmpeg`:

- `thumbnail` filter picks a representative frame
- the frame is resized to width `640`
- output is encoded as WebP

## Video preview generation

When a video needs a derived preview, Foldergram transcodes it with `ffmpeg` to:

- H.264 video
- AAC audio when audio is present
- `yuv420p`
- `+faststart`
- landscape-equivalent output up to `1280x720`
- portrait and square output that keeps the short edge at or below `720`
- even-numbered output dimensions for encoder compatibility

## Direct-original video playback

Foldergram can mark the original video as eligible for direct playback in the
detail player when all of these are true:

- the file extension is `.mp4`
- the container is compatible with MP4
- the video codec is H.264
- the pixel format is `yuv420p`
- the audio codec is AAC, or there is no audio track

When that happens:

- `playbackStrategy` is set to `original`
- generated previews still remain the default playback source
- the detail player can expose an `HD` switch when the original is compatible and higher resolution than the generated preview
- ordinary feed cards and other list surfaces continue to use generated preview media

### Reels: original, lossless remux, then compatible preview

The Reels player uses a separate, on-demand playback decision for the active
video. It does not require rescanning an existing library or changing original
media. Only the active card requests media; selecting a source does not prewarm
the whole feed.

1. Try the indexed original first, including MP4 with HEVC and MOV/MKV/M4V/WebM.
   Neither an old `preview` strategy nor an empty `canPlayType` prediction
   triggers conversion. Initial resolution and original delivery do not probe
   or generate media; the scoped native video loader lets the browser try bytes.
2. After a playback compatibility failure, compatible H.264/AAC content can use a lossless MP4 remux:
   `-c copy` preserves the video/audio streams and resolution. This still creates
   a derived file and may take time on first use; it is not a renamed original
   or a lower-quality transcode.
3. If lossless remux is unsuitable or decoding still fails, use the existing
   H.264/AAC preview. Originals are not guaranteed playable on every browser.

Only a requested fallback probes the file, with bounded concurrency
and a bounded source-version cache; no database migration or bulk scan occurs.
Remux files have a separate recipe/version and live under
`PREVIEWS_DIR/.reel-remux/`. They are served only through the scoped Reels media
route, with visibility, identity, version, Range and output-lock checks. Valid
existing caches remain usable when the source is offline or probing fails.
Cold remuxes and cold previews finish before delivery; subsequent requests reuse
their valid caches. Remux files can be similar in size to the original and are
not application recovery points or original-media backups.

An explicit decoding error may fall back along this chain once per source.
An unsupported-source error first checks that the original endpoint is healthy
(HEAD, successful video response); failed HTTP checks do not start conversion.
Network errors, cancellation, buffering, user pause and autoplay restrictions
do not automatically trigger conversion. After a playback error, users can
retry or explicitly choose **使用兼容预览（可能需要转换）**. Autoplay rejection
instead asks for a click. The ordinary gallery/Viewer playback policy is unchanged.

## GIF handling

GIF files are accepted as supported images, but derivatives are generated with
`animated: false`. In practice that means Foldergram treats GIF derivatives as
static image outputs, not animated preview pipelines.

## Timestamp sources

Foldergram resolves `taken_at` from the best available source:

- EXIF or embedded media metadata when available
- file modification time or first-seen timing when richer metadata is absent

Those timestamps influence:

- Recent feed ordering
- Moments eligibility
- Highlights fallback behavior

## Thumbnail-only rebuild

The thumbnail rebuild action:

- removes the thumbnail cache directory
- recreates it
- rebuilds thumbnails and video poster images for currently indexed media

It does not regenerate previews. In lazy mode it acts as a thumbnail and poster
prewarm only; preview generation still happens on demand.

## Why derivatives are sharded by asset key

Sharding keeps derivative directories small and decouples cache storage from the
gallery tree. That lets Foldergram:

- preserve the same thumbnail and preview paths when a media item is moved
- migrate existing derivatives in place instead of regenerating everything
- garbage-collect stale derivatives by indexed asset reference instead of by mirrored folder tree

## Carousel items

Every included carousel item uses the normal thumbnail, preview, poster, and lazy-generation pipeline. Position 1 supplies the feed/grid cover; later items are fitted inside the shared stage without modifying originals. Only the first 20 naturally sorted supported files are indexed, and skipped extras do not enter derivative queues.
