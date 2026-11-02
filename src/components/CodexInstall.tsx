import { useState } from 'react'
import { addToCodex, canAddToCodex, codexDesktopLink } from '../lib/codexConnection'
import { isDesktopShell } from '../lib/shell'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { CodeBlock } from './ui/code-block'
import { InstallBlock } from './ui/install-block'
import { useT } from '../lib/i18n'

export function CodexInstall({ mcpUrl, canvasId }: { mcpUrl: string; canvasId?: string }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle')
  const [error, setError] = useState('')

  async function connect() {
    setState('adding')
    setError('')
    try {
      await addToCodex()
      setState('added')
      posthog.capture('codex_connection_configured')
    } catch (err) {
      setState('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const manual = (
    <>
      <p>{t('workspace.codexManual')}</p>
      <CodeBlock text={`codex mcp add doop --url ${mcpUrl}`} className="mt-2" />
    </>
  )

  if (canAddToCodex()) {
    return (
      <InstallBlock
        action={
          <Button variant="solid" disabled={state !== 'idle'} onClick={() => void connect()}>
            {state === 'adding'
              ? t('workspace.codexAdding')
              : state === 'added'
                ? t('workspace.codexAdded')
                : t('workspace.codexAdd')}
          </Button>
        }
        status={state === 'added' && t('workspace.codexConfigured')}
        error={error}
        manual={manual}
      />
    )
  }
  if (isDesktopShell()) {
    return <InstallBlock action={<p>{t('workspace.codexUpdateDesktop')}</p>} manual={manual} />
  }
  return (
    <InstallBlock
      action={
        <Button asChild variant="solid">
          <a
            href={codexDesktopLink(new URL(mcpUrl).origin, canvasId)}
            onClick={() => posthog.capture('codex_desktop_setup_opened')}
          >
            {t('workspace.openDesktop')}
          </a>
        </Button>
      }
      status={t('workspace.codexNeedsDesktop')}
      manual={manual}
    />
  )
}
