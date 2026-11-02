/** Hard ceiling on any single ffmpeg/ffprobe invocation. */
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

/** Thumbnail target box. The frame is fitted inside it, preserving aspect ratio. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/**
 * Where in the video the thumbnail frame is taken from. Not frame 0: the first frame
 * of a real video is very often black or a fade-in (per phase-03-videos/TD-10).
 */
export const THUMBNAIL_POSITION_RATIO = 0.1;

/** Fallback seek offset when the probe could not determine a duration. */
export const THUMBNAIL_FALLBACK_SECONDS = 0;

export const FFPROBE_BIN = 'ffprobe';
export const FFMPEG_BIN = 'ffmpeg';

/** Mirrors the queue's `retryLimit` — the attempt counter is capped at it. */
export const MAX_PROCESSING_ATTEMPTS = 3;
