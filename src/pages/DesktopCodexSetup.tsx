import { navigate } from '../App'
import { ConnectModal } from '../components/ConnectModal'
import { Button } from '../components/ui/button'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { parseCodexSetup } from '../lib/codexConnection'
import { useT } from '../lib/i18n'

export function DesktopCodexSetup() {
  const t = useT()
  const request = parseCodexSetup(location.search, location.origin)
  if (!request) {
    return (
      <AuthScreen>
        <AuthCard title={t('connect.codexSetupTitle')}>
          <AuthCardText>{t('connect.codexSetupBody')}</AuthCardText>
          <Button className="self-start" onClick={() => navigate('/')}>
            {t('connect.backToDoop')}
          </Button>
        </AuthCard>
      </AuthScreen>
    )
  }
  return (
    <ConnectModal
      initialAgent="codex"
      showAgentStatus={false}
      canvasId={request.canvasId}
      onClose={() => navigate(request.canvasId ? `/c/${request.canvasId}` : '/')}
    />
  )
}
