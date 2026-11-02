import { create } from 'zustand'

/**
 * The phone rail drawer, shared between the rail that renders it and the
 * header that opens it. `mounted` is true while an AppRail is on the page,
 * so a header on a page with its own sidebar draws no toggle.
 */
export const useRailDrawer = create<{
  open: boolean
  mounted: boolean
  setOpen: (open: boolean) => void
  setMounted: (mounted: boolean) => void
}>((set) => ({
  open: false,
  mounted: false,
  setOpen: (open) => set({ open }),
  setMounted: (mounted) => set(mounted ? { mounted } : { mounted, open: false }),
}))
