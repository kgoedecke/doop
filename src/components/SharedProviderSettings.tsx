import { useEffect, useState } from 'react'
import { adminApi, type AdminSharedProvider, type AdminSharedProviders } from '../lib/api'
import { useT } from '../lib/i18n'
import type { CustomProviderKind } from '../../shared/customProvider'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { ConfirmDialog } from './ui/alert-dialog'
import { Switch } from './ui/switch'
import { CustomProviderForm } from './CustomProviderForm'

/**
 * Admin → Shared models: custom providers set up once for every person on
 * the instance (server/sharedModelAccounts.ts). Each shows beside a person's
 * own connections in Settings and the composer; they pick its model or switch
 * it off for themselves, and never see its key. Adding and editing reuse
 * Settings' custom provider form in admin mode.
 */
export function SharedProviderSettings() {
  const t = useT()
  const [view, setView] = useState<AdminSharedProviders | null>(null)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /* the form: adding one, or editing the one named */
  const [form, setForm] = useState<'new' | CustomProviderKind | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AdminSharedProvider | null>(null)

  /* the list loads once; every change answers with the new list */
  const load = () =>
    adminApi
      .sharedProviders()
      .then((next) => {
        setView(next)
        setFailed(false)
      })
      .catch(() => setFailed(true))

  useEffect(() => {
    void load()
  }, [])

  async function change(request: () => Promise<AdminSharedProviders>) {
    setBusy(true)
    setError(null)
    try {
      setView(await request())
    } catch (e) {
      const body = (e as { body?: { error?: unknown } })?.body
      setError(typeof body?.error === 'string' && body.error ? body.error : t('admin.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (failed) {
    return (
      <div className="mt-7 flex flex-wrap items-center gap-2.5">
        <p className="text-copy text-ink-soft">{t('admin.sharedLoadFailed')}</p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          {t('admin.tryAgain')}
        </Button>
      </div>
    )
  }
  if (!view) return <p className="mt-7 text-copy text-ink-soft">{t('admin.loading')}</p>

  const editing = form && form !== 'new' ? view.providers.find((p) => p.kind === form) : undefined
  const available = view.customProviders

  return (
    <div className="mt-4 flex flex-col gap-4">
      {!available && <Callout>{t('admin.sharedOff')}</Callout>}
      {error && <Callout tone="error">{error}</Callout>}
      <SettingsCard>
        <CardHeader className="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{t('admin.sharedTitle')}</CardTitle>
            <CardDescription>{t('admin.sharedDescription')}</CardDescription>
          </div>
          {available && (
            <Button size="sm" className="flex-none" onClick={() => setForm('new')} disabled={busy}>
              {t('admin.sharedAdd')}
            </Button>
          )}
        </CardHeader>
        {view.providers.length === 0 ? (
          <CardRow>
            <span className="text-body text-ink-soft">{t('admin.sharedEmpty')}</span>
          </CardRow>
        ) : (
          view.providers.map((provider) => (
            <ProviderRow
              key={provider.kind}
              provider={provider}
              busy={busy || !available}
              onToggle={(enabled) => void change(() => adminApi.setSharedProviderEnabled(provider.kind, enabled))}
              onEdit={() => setForm(provider.kind)}
              onDelete={() => setConfirmDelete(provider)}
            />
          ))
        )}
      </SettingsCard>

      {form && (form === 'new' || editing) && (
        <CustomProviderForm
          admin
          {...(editing ? { provider: editing } : {})}
          onClose={() => setForm(null)}
          onSaved={(next) => {
            setView(next)
            setError(null)
            setForm(null)
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={t('admin.sharedDeleteTitle', { name: confirmDelete?.custom.name ?? '' })}
        description={t('admin.sharedDeleteDescription')}
        confirmLabel={t('admin.sharedDelete')}
        destructive
        onConfirm={() => {
          const target = confirmDelete
          setConfirmDelete(null)
          if (target) void change(() => adminApi.deleteSharedProvider(target.kind))
        }}
      />
    </div>
  )
}

/** A custom provider's line: the host it talks to. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function ProviderRow({
  provider,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  provider: AdminSharedProvider
  busy: boolean
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useT()
  const { custom } = provider
  const id = `shared-${provider.kind.replace(/[^a-z0-9]/gi, '-')}`
  return (
    <CardRow
      label={
        <span className="flex flex-wrap items-center gap-2 text-ink">
          {custom.name}
          {!provider.enabled && <Badge>{t('models.off')}</Badge>}
        </span>
      }
      action={
        <>
          <Switch
            id={id}
            size="sm"
            checked={provider.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={t('admin.sharedUse', { name: custom.name })}
          />
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
            {t('admin.sharedEdit')}
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}>
            {t('admin.sharedDelete')}
          </Button>
        </>
      }
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-body text-ink-faint">
        <span>{custom.apiType === 'anthropic' ? t('models.customApiAnthropic') : t('models.customApiOpenai')}</span>
        <span>·</span>
        <span className="truncate font-mono" title={custom.baseUrl}>
          {hostOf(custom.baseUrl)}
        </span>
        <span>·</span>
        <span>{t('admin.sharedModelCount', { count: custom.models.length })}</span>
        <span>·</span>
        {custom.imageModels?.length ? (
          <>
            <span>{t('admin.sharedImageModelCount', { count: custom.imageModels.length })}</span>
            <span>·</span>
          </>
        ) : null}
        <span>{custom.hasKey ? t('admin.sharedKeySet') : t('admin.sharedNoKey')}</span>
      </span>
    </CardRow>
  )
}
