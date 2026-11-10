import { useId, useState } from 'react'
import { api } from '../lib/api'
import type { CustomProviderInput, ModelAccounts, ModelAccountStatus } from '../lib/api'
import { useT } from '../lib/i18n'
import {
  headersFromText,
  isCustomProviderKind,
  parseCustomProviderConfig,
  type CustomApiType,
  type CustomProviderKind,
  type CustomTokenParam,
} from '../../shared/customProvider'
import { Button } from './ui/button'
import { Disclosure } from './ui/collapsible'
import { Field } from './ui/field'
import { IconButton } from './ui/icon-button'
import { PlusIcon, TrashIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
import { FieldError } from './ConnectionTable'

/**
 * Settings → Doop Agent → Custom provider: any OpenAI- or Anthropic-
 * compatible API by its base URL, an optional key and the models it should
 * offer, each with whether it sees images and how much it may write per
 * turn. Fetch models asks the endpoint for its list; Test runs one turn that
 * has to call a tool, which is how the agent does all its work.
 *
 * On an edit the stored key and headers are never shown: blank fields keep
 * them, and each has its own Remove.
 */

interface ModelRow {
  key: number
  id: string
  maxOutputTokens: string
  vision: boolean
}

let nextRowKey = 0
const row = (id = '', vision = false, maxOutputTokens = ''): ModelRow => ({
  key: nextRowKey++,
  id,
  maxOutputTokens,
  vision,
})

export function CustomProviderForm({
  provider,
  onSaved,
  onClose,
}: {
  /** the provider being edited; a new one when unset */
  provider?: ModelAccountStatus
  onSaved: (view: ModelAccounts) => void
  onClose: () => void
}) {
  const t = useT()
  const ids = useId()
  const stored = provider?.custom
  const kind: CustomProviderKind | undefined = isCustomProviderKind(provider?.kind) ? provider.kind : undefined
  const [name, setName] = useState(stored?.name ?? '')
  const [apiType, setApiType] = useState<CustomApiType>(stored?.apiType ?? 'openai-chat')
  const [baseUrl, setBaseUrl] = useState(stored?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [models, setModels] = useState<ModelRow[]>(
    stored?.models.map((m) => row(m.id, m.vision, m.maxOutputTokens ? String(m.maxOutputTokens) : '')) ?? [row()],
  )
  const [headersText, setHeadersText] = useState('')
  const [clearHeaders, setClearHeaders] = useState(false)
  const [tokenParam, setTokenParam] = useState<CustomTokenParam>(stored?.tokenParam ?? 'max_tokens')
  const [echoReasoning, setEchoReasoning] = useState(stored?.echoReasoning ?? false)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<'save' | 'fetch' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [tested, setTested] = useState('')

  const savedHeaders = clearHeaders ? [] : (stored?.headerNames ?? [])
  const keySaved = Boolean(stored?.hasKey) && !clearKey

  const failWith = (e: unknown) => {
    const body = (e as { body?: { error?: string } })?.body
    setError(body?.error || (e instanceof Error ? e.message : t('models.failedRetry')))
  }

  /** What the form says, checked as the server will check it. */
  function input(): CustomProviderInput | null {
    const config = parseCustomProviderConfig({
      name,
      apiType,
      baseUrl,
      models: models
        .filter((m) => m.id.trim())
        .map((m) => ({ id: m.id, vision: m.vision, maxOutputTokens: m.maxOutputTokens.trim() || undefined })),
      tokenParam,
      echoReasoning,
    })
    if (!config.ok) {
      setError(config.error)
      return null
    }
    const headers = headersFromText(headersText)
    if (!headers.ok) {
      setError(headers.error)
      return null
    }
    const key = apiKey.trim()
    return {
      ...config.value,
      /* left out on an edit = keep what is stored */
      ...(key ? { apiKey: key } : clearKey || !kind ? { apiKey: '' } : {}),
      ...(Object.keys(headers.value).length ? { headers: headers.value } : clearHeaders ? { headers: {} } : {}),
    }
  }

  /** The key and headers a set-up request should carry: what was typed, else
   *  (on an edit) the server uses the stored ones for `kind`. */
  function probeSecrets() {
    const headers = headersFromText(headersText)
    const key = apiKey.trim()
    return {
      ...(key ? { apiKey: key } : clearKey ? { apiKey: '' } : {}),
      ...(headers.ok && Object.keys(headers.value).length
        ? { headers: headers.value }
        : clearHeaders
          ? { headers: {} }
          : {}),
      ...(kind ? { kind } : {}),
    }
  }

  async function save() {
    setError('')
    const body = input()
    if (!body) return
    setBusy('save')
    try {
      onSaved(kind ? await api.updateCustomProvider(kind, body) : await api.addCustomProvider(body))
    } catch (e) {
      failWith(e)
    } finally {
      setBusy(null)
    }
  }

  async function fetchModels() {
    setError('')
    setBusy('fetch')
    try {
      const { models: listed } = await api.discoverCustomModels({ apiType, baseUrl, ...probeSecrets() })
      setDiscovered(listed)
      if (!listed.length) setError(t('models.customNoModelsListed'))
    } catch (e) {
      failWith(e)
    } finally {
      setBusy(null)
    }
  }

  async function test() {
    setError('')
    setTested('')
    const body = input()
    const first = body?.models[0]
    if (!body || !first) return
    setBusy('test')
    try {
      const result = await api.testCustomProvider({ ...body, ...probeSecrets(), model: first.id })
      setTested(t('models.customTestPassed', { model: result.model }))
    } catch (e) {
      failWith(e)
    } finally {
      setBusy(null)
    }
  }

  const updateRow = (key: number, patch: Partial<ModelRow>) =>
    setModels((rows) => rows.map((m) => (m.key === key ? { ...m, ...patch } : m)))
  const addDiscovered = (id: string) =>
    setModels((rows) => {
      if (rows.some((m) => m.id === id)) return rows
      /* the empty row a new form starts with takes the first pick */
      const blank = rows.find((m) => !m.id.trim())
      return blank ? rows.map((m) => (m === blank ? { ...m, id } : m)) : [...rows, row(id)]
    })
  const unlisted = discovered?.filter((id) => !models.some((m) => m.id === id)) ?? []

  return (
    <Modal size="xl" onClose={onClose}>
      <ModalTitle>
        {kind ? t('models.customEditTitle', { name: stored?.name ?? '' }) : t('models.customTitle')}
      </ModalTitle>
      <ModalLede>{t('models.customLede')}</ModalLede>

      <div className="mt-5 grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('models.customName')} labelVariant="form" htmlFor={`${ids}-name`}>
            <Input
              id={`${ids}-name`}
              variant="well"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('models.customNamePlaceholder')}
              autoFocus
            />
          </Field>
          <Field label={t('models.customApiType')} labelVariant="form">
            <Select value={apiType} onValueChange={(next) => setApiType(next as CustomApiType)}>
              <SelectTrigger aria-label={t('models.customApiType')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-chat">{t('models.customApiOpenai')}</SelectItem>
                <SelectItem value="anthropic">{t('models.customApiAnthropic')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field
          label={t('models.customBaseUrl')}
          labelVariant="form"
          htmlFor={`${ids}-url`}
          hint={apiType === 'anthropic' ? t('models.customBaseUrlAnthropicHint') : t('models.customBaseUrlOpenaiHint')}
        >
          <Input
            id={`${ids}-url`}
            variant="well"
            className="font-mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={apiType === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1'}
            spellCheck={false}
            inputMode="url"
          />
        </Field>
        <Field
          label={t('models.customApiKey')}
          labelVariant="form"
          htmlFor={`${ids}-key`}
          hint={keySaved ? t('models.customKeySavedHint') : t('models.customKeyHint')}
        >
          <div className="flex gap-2">
            <Input
              id={`${ids}-key`}
              variant="well"
              className="flex-1 font-mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keySaved ? t('models.customKeySavedPlaceholder') : t('models.customKeyPlaceholder')}
              spellCheck={false}
              autoComplete="off"
            />
            {keySaved && (
              <Button variant="ghost" onClick={() => setClearKey(true)}>
                {t('models.customRemoveKey')}
              </Button>
            )}
          </div>
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="text-label font-medium text-ink-soft">{t('models.customModels')}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void fetchModels()}
              disabled={busy !== null || !baseUrl.trim()}
            >
              {busy === 'fetch' ? t('models.customFetching') : t('models.customFetchModels')}
            </Button>
          </div>
          <div role="list" className="grid gap-2">
            {models.map((m, index) => (
              <div role="listitem" key={m.key} className="flex flex-wrap items-center gap-2">
                <Input
                  variant="well"
                  className="min-w-[180px] flex-[2] font-mono"
                  value={m.id}
                  onChange={(e) => updateRow(m.key, { id: e.target.value })}
                  placeholder={t('models.customModelIdPlaceholder')}
                  aria-label={t('models.customModelId', { n: index + 1 })}
                  spellCheck={false}
                />
                <Input
                  variant="well"
                  className="w-[150px] flex-1 font-mono"
                  value={m.maxOutputTokens}
                  onChange={(e) => updateRow(m.key, { maxOutputTokens: e.target.value.replace(/[^\d]/g, '') })}
                  placeholder={t('models.customMaxTokensPlaceholder')}
                  aria-label={t('models.customMaxTokens', { n: index + 1 })}
                  inputMode="numeric"
                />
                <label className="flex flex-none items-center gap-2 text-label text-ink-soft">
                  <Switch
                    size="sm"
                    checked={m.vision}
                    onCheckedChange={(vision) => updateRow(m.key, { vision })}
                    aria-label={t('models.customVisionFor', { n: index + 1 })}
                  />
                  {t('models.customVision')}
                </label>
                <IconButton
                  aria-label={t('models.customRemoveModel', { n: index + 1 })}
                  disabled={models.length === 1}
                  onClick={() => setModels((rows) => rows.filter((r) => r.key !== m.key))}
                >
                  <TrashIcon size="rail" aria-hidden />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setModels((rows) => [...rows, row()])}>
              <PlusIcon size="rail" aria-hidden />
              {t('models.customAddModel')}
            </Button>
            {unlisted.length > 0 && (
              <Select value="" onValueChange={addDiscovered}>
                <SelectTrigger size="sm" className="w-[260px] max-w-full" aria-label={t('models.customAddListed')}>
                  <SelectValue placeholder={t('models.customAddListed')} />
                </SelectTrigger>
                <SelectContent>
                  {unlisted.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="mt-1.5 text-caption text-ink-faint">{t('models.customModelsHint')}</p>
        </div>

        <Disclosure label={t('models.customAdvanced')} triggerClassName="text-label font-medium text-ink-soft">
          <div className="grid gap-4">
            <Field
              label={t('models.customHeaders')}
              labelVariant="form"
              htmlFor={`${ids}-headers`}
              hint={
                savedHeaders.length
                  ? t('models.customHeadersSaved', { names: savedHeaders.join(', ') })
                  : t('models.customHeadersHint')
              }
            >
              <Textarea
                id={`${ids}-headers`}
                variant="well"
                className="font-mono"
                rows={3}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder="X-Gateway-Tenant: design"
                spellCheck={false}
              />
              {savedHeaders.length > 0 && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setClearHeaders(true)}>
                  {t('models.customRemoveHeaders')}
                </Button>
              )}
            </Field>
            {apiType === 'openai-chat' && (
              <>
                <Field label={t('models.customTokenParam')} labelVariant="form" hint={t('models.customTokenParamHint')}>
                  <Select value={tokenParam} onValueChange={(next) => setTokenParam(next as CustomTokenParam)}>
                    <SelectTrigger aria-label={t('models.customTokenParam')} className="w-full sm:w-[280px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="max_tokens">max_tokens</SelectItem>
                      <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <label className="flex items-start gap-3 text-label text-ink-soft">
                  <Switch size="sm" checked={echoReasoning} onCheckedChange={setEchoReasoning} />
                  <span>
                    <span className="block font-medium text-ink">{t('models.customEchoReasoning')}</span>
                    {t('models.customEchoReasoningHint')}
                  </span>
                </label>
              </>
            )}
          </div>
        </Disclosure>
      </div>

      <FieldError>{error}</FieldError>
      {tested && !error && <p className="mt-1.5 text-label text-success-ink">{tested}</p>}

      <ModalActions>
        <Button variant="ghost" onClick={() => void test()} disabled={busy !== null}>
          {busy === 'test' ? t('models.customTesting') : t('models.customTest')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy !== null}>
          {busy === 'save' ? t('models.saving') : kind ? t('models.customSave') : t('models.customAdd')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
