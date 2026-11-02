/** the SPA's one way to move: push the path and let App's popstate listener re-render */
export function navigate(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
