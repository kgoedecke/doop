export const IOS_APP_ID = '6820090720'

/** Safari passes this argument to the iOS app's CanvasLink handler on Open. */
export function canvasAppBanner(canvasId: string, origin: string): string {
  return `app-id=${IOS_APP_ID}, app-argument=doop://canvas/${encodeURIComponent(canvasId)}?server=${encodeURIComponent(origin)}`
}
