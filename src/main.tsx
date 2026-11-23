import React from 'react'
import ReactDOM from 'react-dom/client'
import './lib/posthog'
import { App } from './App'
import { initDesktopShell } from './lib/desktop'
import { TooltipProvider } from './components/ui/tooltip'
import { UpdateCard } from './components/UpdateCard'
import { initTheme } from './lib/theme'
import { initLocale } from './lib/i18n'
import { installTranslateGuard } from './lib/translateGuard'
import './styles.css'

const fonts = document.getElementById('app-fonts')
if (fonts instanceof HTMLLinkElement) {
  // The print media lets the page start while the stylesheet downloads.
  if (fonts.sheet) fonts.media = 'all'
  else fonts.addEventListener('load', () => (fonts.media = 'all'), { once: true })
}

const page = document.documentElement
page.dataset.authFont = 'loading'
const useFallbackFont = () => {
  page.dataset.authFont = 'fallback'
}
// Keeping the fallback after a timeout prevents a late Inter download from swapping the login text.
const fontTimeout = window.setTimeout(useFallbackFont, 1500)
void document.fonts
  .load('400 1em Inter')
  .then(() => {
    if (page.dataset.authFont === 'loading') delete page.dataset.authFont
  }, useFallbackFont)
  .finally(() => window.clearTimeout(fontTimeout))

installTranslateGuard()
initDesktopShell()
initTheme()
void initLocale()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      <App />
      <UpdateCard />
    </TooltipProvider>
  </React.StrictMode>,
)
