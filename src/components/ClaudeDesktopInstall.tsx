import { useState } from 'react'
import { addToClaudeDesktop, canAddToClaudeDesktop } from '../lib/claudeConnection'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { InstallBlock } from './ui/install-block'
import { useT } from '../lib/i18n'

export function ClaudeDesktopInstall({ mcpUrl }: { mcpUrl: string }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'opening' | 'opened'>('idle')
  const [error, setError] = useState('')

  async function connect() {
    setState('opening')
    setError('')
    try {
      await addToClaudeDesktop(mcpUrl)
      setState('opened')
      posthog.capture('claude_extension_opened')
    } catch (err) {
      setState('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <InstallBlock
      action={
        canAddToClaudeDesktop() ? (
          <Button variant="solid" disabled={state === 'opening'} onClick={() => void connect()}>
            {state === 'opening'
              ? t('workspace.claudeOpening')
              : state === 'opened'
                ? t('workspace.claudeOpenAgain')
                : t('workspace.claudeAdd')}
          </Button>
        ) : (
          <p>{t('workspace.claudeNeedsDesktop')}</p>
        )
      }
      status={state === 'opened' && t('workspace.claudeConfirm')}
      error={error}
      manualLabel={t('workspace.installManually')}
      manual={
        <p>
          <a className="underline underline-offset-2" href="/claude-extension/doop.mcpb" download="doop.mcpb">
            {t('workspace.downloadExtension')}
          </a>
          {t('workspace.claudeManualOpen')} <strong>Doop server URL</strong> {t('workspace.claudeManualTo')}{' '}
          <code className="break-all">{mcpUrl}</code>
          {t('workspace.claudeManualFallback')}{' '}
          <strong>Settings → Extensions → Advanced settings → Install Extension</strong>.
        </p>
      }
    />
  )
}
