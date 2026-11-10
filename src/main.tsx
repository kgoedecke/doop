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

installTranslateGuard()
initDesktopShell()
initTheme()

/* the language is settled first, so the first paint already speaks it */
void initLocale().then(() =>
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <TooltipProvider>
        <App />
        <UpdateCard />
      </TooltipProvider>
    </React.StrictMode>,
  ),
)
