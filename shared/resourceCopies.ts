/** Explicit clipboard provenance. The server derives parents from stored frames. */
export interface ResourceCopyEntry {
  sourceFrameId: string
  sourceVersion: number
  html: string
  css?: string
}

export interface ResourceCopyRequest {
  entries: ResourceCopyEntry[]
}

export interface ResourceCopyResult {
  canvasId: string
  entries: { html: string; css?: string }[]
  assets: { from: string; to: string; url: string }[]
}
