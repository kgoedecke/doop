import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type AgentModelCatalog,
  type CustomEndpointTestResult,
  type CustomModelProfile,
  type CustomModelProfilePatch,
  type ModelAccountStatus,
} from '../lib/api'
import { useT } from '../lib/i18n'
import { useLocalAgent, refreshLocalAgent } from '../lib/localAgent'
import { activeModelTarget } from '../lib/activeModelTarget'
import { isCustomModelId } from '../../shared/customModel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/field'
import { Switch } from './ui/switch'
import { Checkbox } from './ui/checkbox'
import { ConfirmDialog } from './ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { planMark, planPill } from './ui/model-plan'
import { DoopMark } from './Logo'

/**
 * Saved OpenAI-compatible endpoints. The server keeps every key sealed and
 * never returns one, so this component edits a profile from its redacted view:
 * a blank API-key field on edit means "keep the stored key", and clearing is a
 * separate, explicit choice.
 */

interface Draft {
  id?: string
  name: string
  baseUrl: string
  /** undefined = keep the stored key; null = clear it; a string = replace it */
  apiKey?: string | null
  model: string
  supportsVision: boolean
  /** UI-only discovery state produced by a successful/attempted test */
  selectedModel?: string
  discoveredModels: string[]
  useManualFallback: boolean
  manualModel: string
  testedFingerprint: string | null
}

const emptyDraft = (): Draft => ({
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  supportsVision: true,
  selectedModel: undefined,
  discoveredModels: [],
  useManualFallback: false,
  manualModel: '',
  testedFingerprint: null,
})

function messageFor(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: string } })?.body
  return body?.error || (error instanceof Error ? error.message : fallback)
}

/** The host and path are what distinguish two endpoints; the scheme-less form
 *  reads better beside a name and never reveals an embedded credential (the
 *  server refuses those URLs, so there is none to reveal). */
function endpointLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return baseUrl
  }
}

function fingerprint(draft: Draft): string {
  return JSON.stringify({
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey === null ? null : draft.apiKey?.trim() || '(stored)',
    profileId: draft.id ?? null,
  })
}

function invalidateDiscovery(draft: Draft): Draft {
  return { ...draft, discoveredModels: [], selectedModel: undefined, testedFingerprint: null }
}

export function CustomModelProfiles({
  account,
  onChange,
  onAccountChange,
}: {
  account: ModelAccountStatus
  onChange?: () => void
  onAccountChange?: (next: ModelAccountStatus) => void
}) {
  const t = useT()
  const localPreference = useLocalAgent((state) => state.preference)
  const localEnabled = localPreference?.enabled ?? false
  const customActive = activeModelTarget(localEnabled, account) === 'custom-key'
  const [profiles, setProfiles] = useState<CustomModelProfile[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<CustomEndpointTestResult | null>(null)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CustomModelProfile | null>(null)
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)

  const load = useCallback(async () => {
    try {
      setProfiles(await api.modelProfiles())
    } catch (e) {
      setError(messageFor(e, t('models.failedRetry')))
    } finally {
      setLoaded(true)
    }
  }, [t])

  useEffect(() => {
    let stale = false
    api.modelProfiles().then(
      (next) => {
        if (stale) return
        setProfiles(next)
        setLoaded(true)
      },
      (e: unknown) => {
        if (stale) return
        setError(messageFor(e, t('models.failedRetry')))
        setLoaded(true)
      },
    )
    return () => {
      stale = true
    }
  }, [t, account.connected, account.kind, account.profileId])

  const active = account.connected && account.kind === 'custom-key'
  useEffect(() => {
    if (!active) return
    let stale = false
    api.agentModels().then(
      (next) => {
        if (!stale) setCatalog(next)
      },
      () => {
        if (!stale) setCatalog(null)
      },
    )
    return () => {
      stale = true
    }
  }, [active, account.profileId, account.model])
  const visibleCatalog = active ? catalog : null

  const refreshAccount = useCallback(async () => {
    try {
      onAccountChange?.(await api.modelAccount())
    } catch {
      /* the list still refreshed; the next Settings visit re-reads the account */
    }
  }, [onAccountChange])

  const openNew = () => {
    setDraft(emptyDraft())
    setTestResult(null)
    setError('')
  }

  const openEdit = (profile: CustomModelProfile) => {
    setDraft({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: undefined,
      model: profile.model,
      supportsVision: profile.supportsVision,
      selectedModel: undefined,
      discoveredModels: [],
      useManualFallback: false,
      manualModel: '',
      testedFingerprint: null,
    })
    setTestResult(null)
    setError('')
  }

  const closeForm = () => {
    setDraft(null)
    setTestResult(null)
    setError('')
  }

  const testConnection = async () => {
    if (!draft) return
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      const result = await api.testModelProfile({
        baseUrl: draft.baseUrl.trim(),
        /* undefined keeps a saved profile's key on the server, an entered key
           replaces it for this test, and null means it was deliberately cleared */
        ...(draft.id ? { profileId: draft.id } : {}),
        ...(draft.apiKey !== undefined ? { apiKey: draft.apiKey === null ? null : draft.apiKey.trim() || null } : {}),
      })
      setTestResult(result)
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              discoveredModels: result.reachable ? (result.models ?? []) : [],
              selectedModel: undefined,
              testedFingerprint: fingerprint(prev),
            }
          : prev,
      )
    } catch (e) {
      const result = {
        reachable: false,
        errorCode: 'unknown',
        error: messageFor(e, t('models.customErrorUnknown')),
      }
      setTestResult(result)
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              discoveredModels: [],
              selectedModel: undefined,
              testedFingerprint: fingerprint(prev),
            }
          : prev,
      )
    } finally {
      setTesting(false)
    }
  }

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), refreshAccount()])
  }, [load, refreshAccount])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      const model = (draft.useManualFallback ? draft.manualModel : (draft.selectedModel ?? draft.model)).trim()
      const base = {
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        model,
        supportsVision: draft.supportsVision,
      }
      if (draft.id) {
        const patch: CustomModelProfilePatch = { ...base }
        if (draft.apiKey !== undefined) patch.apiKey = draft.apiKey?.trim() || null
        await api.updateModelProfile(draft.id, patch)
      } else {
        await api.createModelProfile({
          ...base,
          ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        })
      }
      setDraft(null)
      setTestResult(null)
      await refreshAll()
      onChange?.()
    } catch (e) {
      setError(messageFor(e, t('models.failedRetry')))
    } finally {
      setBusy(false)
    }
  }

  const activate = async (profile: CustomModelProfile) => {
    setBusy(true)
    setError('')
    try {
      const next = await api.activateModelProfile(profile.id)
      onAccountChange?.(next)
      await load()
      await refreshLocalAgent()
      onChange?.()
    } catch (e) {
      setError(messageFor(e, t('models.failedRetry')))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError('')
    try {
      await api.disconnectModelAccount()
      await refreshAll()
      await refreshLocalAgent()
      onChange?.()
    } catch (e) {
      setError(messageFor(e, t('models.failedRetry')))
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target) return
    setBusy(true)
    setError('')
    try {
      await api.deleteModelProfile(target.id)
      await refreshAll()
      onChange?.()
    } catch (e) {
      setError(messageFor(e, t('models.failedRetry')))
    } finally {
      setBusy(false)
    }
  }

  const pickModel = async (model: string) => {
    if (model === account.model) return
    setBusy(true)
    setError('')
    try {
      onAccountChange?.(await api.setAgentModel(model))
      onChange?.()
    } catch (e) {
      setError(messageFor(e, t('models.failedRetry')))
    } finally {
      setBusy(false)
    }
  }

  const models = visibleCatalog?.live ? visibleCatalog.models : []
  const missingModel = account.model && !models.some((model) => model.id === account.model)
  const canSave = Boolean(
    draft &&
    draft.name.trim() &&
    draft.baseUrl.trim() &&
    draft.testedFingerprint === fingerprint(draft) &&
    (draft.useManualFallback ? isCustomModelId(draft.manualModel) : Boolean(draft.selectedModel)),
  )
  let errorText = ''
  if (testResult && !testResult.reachable) {
    switch (testResult.errorCode) {
      case 'invalid_url':
        errorText = t('models.customErrorInvalidUrl')
        break
      case 'url_insecure':
        errorText = t('models.customErrorUrlInsecure')
        break
      case 'private_url_blocked':
        errorText = t('models.customErrorPrivateUrl')
        break
      case 'unreachable':
        errorText = t('models.customErrorUnreachable')
        break
      case 'auth_failed':
        errorText = t('models.customErrorAuth')
        break
      case 'not_compatible':
        errorText = t('models.customErrorNotCompatible')
        break
      case 'invalid_input':
        errorText = t('models.customErrorInvalidInput')
        break
      default:
        errorText = testResult.error ?? t('models.customErrorUnknown')
    }
  }

  return (
    <section className="border-t border-line-soft">
      <div className="flex gap-[14px] px-[22px] py-[18px] max-md:gap-3 max-md:px-4 max-md:py-[17px]">
        <span className={planMark(customActive)}>
          <DoopMark size={18} className="block" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
            <h3 className="font-display text-heading font-semibold text-ink max-md:text-heading">
              {t('models.customTitle')}
            </h3>
            {customActive && <span className={planPill(true)}>{t('models.customActive')}</span>}
          </div>
          <p className="mt-1.5 text-copy text-ink-soft max-md:text-copy">{t('models.customLede')}</p>
          <p className="mt-2 text-body text-ink-faint">
            {t('models.customSelfHostNote')} {t('models.customReplaceNote')}
          </p>

          {!draft && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={openNew} disabled={busy}>
                {t('models.customAdd')}
              </Button>
            </div>
          )}

          {loaded && profiles.length === 0 && !draft && (
            <p className="mt-3 text-body text-ink-faint">{t('models.customEmpty')}</p>
          )}

          {profiles.map((profile) => (
            <div key={profile.id} className="mt-3 rounded-card border border-line px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-copy font-semibold text-ink">{profile.name}</span>
                    {profile.active && customActive && (
                      <span className={planPill(true)}>{t('models.customActive')}</span>
                    )}
                  </div>
                  <p className="mt-1 text-label text-ink-soft [overflow-wrap:anywhere]">
                    {endpointLabel(profile.baseUrl)}
                  </p>
                  <p className="mt-1 text-label text-ink-faint">
                    <code className="font-mono">{profile.model}</code>
                    {' · '}
                    {profile.supportsVision ? t('models.customVision') : t('models.noVisualReview')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!profile.active && (
                    <Button size="sm" onClick={() => void activate(profile)} disabled={busy}>
                      {t('models.customActivate')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => openEdit(profile)} disabled={busy}>
                    {t('models.customEdit')}
                  </Button>
                  <Button variant="bare-danger" size="sm" onClick={() => setPendingDelete(profile)} disabled={busy}>
                    {t('models.customDelete')}
                  </Button>
                </div>
              </div>

              {profile.active && account.model && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-label text-ink-soft">{t('models.customModel')}</span>
                  {models.length > 0 ? (
                    <Select value={account.model} onValueChange={(model) => void pickModel(model)} disabled={busy}>
                      <SelectTrigger size="sm" className="max-w-[280px]" aria-label={t('models.customModel')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                          </SelectItem>
                        ))}
                        {missingModel && <SelectItem value={account.model}>{account.model}</SelectItem>}
                      </SelectContent>
                    </Select>
                  ) : (
                    <code className="text-label text-ink">{account.model}</code>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={busy}>
                    {t('models.disconnect')}
                  </Button>
                </div>
              )}
              {profile.active && visibleCatalog && !visibleCatalog.live && (
                <p className="mt-2 text-body text-ink-faint">{t('models.customCatalogFallback')}</p>
              )}
            </div>
          ))}

          {draft && (
            <div className="mt-3 rounded-card border border-line px-3 py-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('models.customName')} htmlFor="custom-model-name">
                  <Input
                    id="custom-model-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder={t('models.customNamePlaceholder')}
                    autoFocus
                  />
                </Field>
                <Field label={t('models.customBaseUrl')} htmlFor="custom-model-url">
                  <Input
                    id="custom-model-url"
                    value={draft.baseUrl}
                    onChange={(e) => setDraft(invalidateDiscovery({ ...draft, baseUrl: e.target.value }))}
                    placeholder={t('models.customBaseUrlPlaceholder')}
                    spellCheck={false}
                  />
                </Field>
                <Field label={t('models.customModel')} htmlFor="custom-model-discovered">
                  {draft.discoveredModels.length > 0 ? (
                    <Select
                      value={draft.selectedModel ?? ''}
                      onValueChange={(model) => setDraft({ ...draft, selectedModel: model, model })}
                    >
                      <SelectTrigger id="custom-model-discovered" size="md" aria-label={t('models.customModel')}>
                        <SelectValue placeholder={t('models.customModel')} />
                      </SelectTrigger>
                      <SelectContent>
                        {draft.discoveredModels.map((model) => (
                          <SelectItem key={model} value={model}>
                            {model}
                          </SelectItem>
                        ))}
                        {draft.id && draft.model && !draft.discoveredModels.includes(draft.model) && (
                          <SelectItem value={draft.model} disabled>
                            {draft.model}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-body text-ink-faint">{t('models.customModelPlaceholder')}</p>
                  )}
                </Field>
                <Field
                  label={t('models.customApiKey')}
                  htmlFor="custom-model-key"
                  hint={draft.id ? t('models.customKeyKeep') : undefined}
                >
                  <Input
                    id="custom-model-key"
                    value={draft.apiKey ?? ''}
                    onChange={(e) => setDraft(invalidateDiscovery({ ...draft, apiKey: e.target.value }))}
                    placeholder={t('models.customApiKeyPlaceholder')}
                    type="password"
                    autoComplete="off"
                    disabled={draft.id !== undefined && draft.apiKey === null}
                    spellCheck={false}
                  />
                </Field>
              </div>

              {testResult && (
                <div className="mt-3 flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-body text-ink-soft">
                    <Checkbox
                      name="models-fallback"
                      checked={draft.useManualFallback}
                      onChange={(e) => setDraft({ ...draft, useManualFallback: e.target.checked })}
                    />
                    {t('models.customUseUnverifiedModel')}
                  </label>
                  {!draft.useManualFallback && (
                    <Button variant="link" size="sm" onClick={() => setDraft({ ...draft, useManualFallback: true })}>
                      {t('models.customUseUnverifiedModel')}
                    </Button>
                  )}
                  {draft.useManualFallback && (
                    <Field label={t('models.customManualModel')} htmlFor="custom-model-manual">
                      <Input
                        id="custom-model-manual"
                        name="models-manual"
                        value={draft.manualModel}
                        onChange={(e) => setDraft({ ...draft, manualModel: e.target.value, model: e.target.value })}
                        placeholder={t('models.customModelPlaceholder')}
                        spellCheck={false}
                      />
                    </Field>
                  )}
                </div>
              )}

              <div className="mt-3 flex items-start gap-2">
                <Switch
                  size="sm"
                  checked={draft.supportsVision}
                  onCheckedChange={(supportsVision) => setDraft({ ...draft, supportsVision })}
                  aria-label={t('models.customVision')}
                />
                <div>
                  <span className="block text-body font-medium text-ink">{t('models.customVision')}</span>
                  <span className="mt-0.5 block text-label text-ink-faint">{t('models.customVisionHint')}</span>
                </div>
              </div>

              {draft.id && (
                <label className="mt-3 flex items-center gap-2 text-body text-ink-soft">
                  <Checkbox
                    checked={draft.apiKey === null}
                    onChange={(e) =>
                      setDraft(invalidateDiscovery({ ...draft, apiKey: e.target.checked ? null : undefined }))
                    }
                  />
                  {t('models.customKeyClear')}
                </label>
              )}

              {testResult?.reachable && (
                <p className="mt-3 text-body text-success-ink">
                  {t('models.customConnectionOk', { count: testResult.models?.length ?? 0 })}
                </p>
              )}
              {errorText && <p className="mt-3 text-body text-accent-ink">{errorText}</p>}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => void save()} disabled={busy || !canSave}>
                  {busy ? t('models.customSaving') : t('models.customSave')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void testConnection()}
                  disabled={busy || testing || !draft.baseUrl.trim()}
                >
                  {testing ? t('models.customTesting') : t('models.customTest')}
                </Button>
                <Button variant="bare" onClick={closeForm} disabled={busy || testing}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-body text-accent-ink">{error}</p>}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={t('models.customDeleteTitle', { name: pendingDelete?.name ?? '' })}
        description={t('models.customDeleteBody')}
        confirmLabel={t('models.customDeleteConfirm')}
        destructive
        onConfirm={() => void confirmDelete()}
      />
    </section>
  )
}
