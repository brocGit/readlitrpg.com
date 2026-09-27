// The media pipeline's jobs (DESIGN §15.7, §16.5): find licensed covers for books without one, and
// re-encode pending images into the WebP variants readers see.

import { fetchOpenLibraryCovers, processPendingMedia, type Transformer } from "@rlr/core/media";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

/** The Images binding re-encodes and resizes (never upscales); re-encoding also drops EXIF and GPS. */
export function imagesTransformer(images: ImagesBinding): Transformer {
  return async (bytes, width) => {
    const result = await images
      .input(new Blob([bytes]).stream())
      .transform({ width, fit: "scale-down" })
      .output({ format: "image/webp", quality: 82 });
    return new Uint8Array(await result.response().arrayBuffer());
  };
}

export async function processMedia(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  return processPendingMedia(
    db,
    { private: env.PRIVATE, media: env.MEDIA },
    {
      transform: imagesTransformer(env.IMAGES),
      mediaOrigin: env.PUBLIC_MEDIA_ORIGIN,
      reviewPriority: settings["editorial.priorities"].image_review,
      log,
      now: ctx.now,
    },
    10,
  );
}

export async function findCovers(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  const { checked, found } = await fetchOpenLibraryCovers(
    db,
    { private: env.PRIVATE },
    { fetch: ctx.fetch, pause: ctx.pause, log, now: ctx.now },
    10,
  );
  if (found > 0) {
    log.info("media.covers_found", { checked, found });
    await processMedia(ctx);
  }
  return checked;
}
