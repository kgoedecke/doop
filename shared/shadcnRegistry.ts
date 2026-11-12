/** Public metadata only; registry source is fetched and validated on the server. */
export interface RegistryItemSummary {
  name: string
  title: string
  description: string
  type: string
}

export interface RegistryPreview {
  url: string
  name: string
  items: RegistryItemSummary[]
}
