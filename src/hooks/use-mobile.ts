import { useEffect, useState } from 'react'

/* Mirrors --breakpoint-md in styles.css: below this the canvas swaps its
   rails for sheets and the dashboard hides its sidebar. Change both together. */
export const MOBILE_QUERY = '(max-width: 900px)'

/** One shared breakpoint for the dashboard rail and canvas workspace. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const sync = () => setMobile(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return mobile
}
