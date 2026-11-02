# Test fixtures

## `sample.mp4`

Committed on purpose: the `ffprobe` assertions need a file whose metadata is known
and stable. Generating it at test time would make the expected values depend on
whichever ffmpeg build happens to be installed.

Produced by the `video-worker` container's own ffmpeg (`5.1.9-0+deb12u1`):

```bash
docker compose exec video-worker ffmpeg -y \
  -f lavfi -i "testsrc=duration=2:size=320x240:rate=25" \
  -c:v libx264 -pix_fmt yuv420p -g 25 \
  src/test/fixtures/sample.mp4
```

Metadata the suites assert against — keep this table and the file in sync:

| Property | Value |
|----------|-------|
| `duration` | `2.000000` s |
| `width` × `height` | 320 × 240 |
| `codec_name` | `h264` |
| `format_name` | `mov,mp4,m4a,3gp,3g2,mj2` |
| `size` | 15725 bytes |

The file is declared as an asset in `nest-cli.json`; without that it exists under
`src/` and is missing from `dist/`, which fails only after a build.

## `sample-no-metadata.h264`

A **raw H.264 elementary stream** — no container, so `ffprobe` genuinely omits
`duration` and `bit_rate` from its `format` block. Committed because it is the only
honest way to test the "a field absent from the ffprobe output must persist as NULL
and the job must still succeed" requirement (phase-03-videos/TD-09 revision,
SI-03.6 AC). Constructing that case by mocking would test the mock, not ffprobe.

```bash
docker compose exec video-worker ffmpeg -y \
  -f lavfi -i "testsrc=duration=2:size=160x120:rate=25" \
  -c:v libx264 -bsf:v h264_mp4toannexb -f h264 \
  src/test/fixtures/sample-no-metadata.h264
```

| Property | Value |
|----------|-------|
| `format_name` | `h264` |
| `duration` | **absent** from the probe output |
| `bit_rate` | **absent** from the probe output |
| `width` × `height` | 160 × 120 |
| `codec_name` | `h264` |
| `size` | 8958 bytes |

Because the duration is unknown, the thumbnail seek falls back to offset 0 — which
is precisely what `THUMBNAIL_FALLBACK_SECONDS` exists for.
