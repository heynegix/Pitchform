export const TIMELINE_GUTTER_PX = 52;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function secondsToCanvasX(seconds: number, durationSeconds: number, canvasWidth: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(canvasWidth)) {
    return TIMELINE_GUTTER_PX;
  }
  const timelineWidth = Math.max(1, canvasWidth - TIMELINE_GUTTER_PX);
  return TIMELINE_GUTTER_PX + (clamp(seconds, 0, durationSeconds) / durationSeconds) * timelineWidth;
}

export function clientXToSeconds(clientX: number, rectLeft: number, rectWidth: number, durationSeconds: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(rectLeft) || !Number.isFinite(rectWidth)
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const timelineWidth = rectWidth - TIMELINE_GUTTER_PX;
  if (timelineWidth <= 0) return 0;
  const position = (clientX - rectLeft - TIMELINE_GUTTER_PX) / timelineWidth;
  return clamp(position * durationSeconds, 0, durationSeconds);
}

export function isClientXInTimeline(clientX: number, rectLeft: number, rectWidth: number): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(rectLeft) || !Number.isFinite(rectWidth)) return false;
  const relativeX = clientX - rectLeft;
  return relativeX >= TIMELINE_GUTTER_PX && relativeX <= rectWidth;
}
