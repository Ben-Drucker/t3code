/**
 * Anthropic rejects an image over 2000px on a side once a request holds more than 20 images, and
 * Claude Code forwards images sent into a running turn unchanged, so one large paste breaks
 * every later request in that thread.
 */
export const IMAGE_ATTACHMENT_MAX_EDGE = 2000;

export function inlineImageSize(
  width: number,
  height: number,
  displayScale: number,
  maxWidth: number,
  maxHeight: number,
) {
  if (![width, height, displayScale, maxWidth, maxHeight].every((n) => Number.isFinite(n) && n > 0))
    return null;
  const factor = Math.min(1 / displayScale, maxWidth / width, maxHeight / height);
  return { width: width * factor, height: height * factor };
}

export type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

export function fitImageAttachmentSize(size: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale))),
  };
}
