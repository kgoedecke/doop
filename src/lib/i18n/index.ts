import { en } from './en'
import { ptBR } from './pt-BR'
import { getLocale, useLocale, type Locale } from './locale'

export { LOCALES, LOCALE_NAMES, isLocale, getLocale, setLocale, useLocale, initLocale, type Locale } from './locale'

/* English is the source catalog: its keys are the message keys, and its
   strings decide which {placeholders} a key takes. Every other language must
   carry the same keys, which the Catalog type enforces at compile time. */
type En = typeof en
type Namespace = keyof En

/** A message with a {count} that reads differently for one and for many. */
export type PluralMessage = { readonly one: string; readonly other: string }
type Message = string | PluralMessage

type Widen<M> = M extends string ? string : PluralMessage

/** The shape a translation has to fill: every English key, as plain strings. */
export type Catalog = { [N in Namespace]: { readonly [K in keyof En[N]]: Widen<En[N][K]> } }

/** "namespace.key", e.g. "settings.appearanceTitle". */
export type MessageKey = { [N in Namespace]: `${N}.${Extract<keyof En[N], string>}` }[Namespace]

type MessageOf<K extends MessageKey> = K extends `${infer N}.${infer M}`
  ? N extends Namespace
    ? M extends keyof En[N]
      ? En[N][M]
      : never
    : never
  : never

type Placeholders<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never

type ParamsOf<M> = M extends string
  ? Placeholders<M>
  : M extends PluralMessage
    ? Placeholders<M['one']> | Placeholders<M['other']> | 'count'
    : never

/* a key without placeholders takes no second argument; one with them must
   be given every value it names */
type VarsArg<K extends MessageKey> = [ParamsOf<MessageOf<K>>] extends [never]
  ? []
  : [vars: Record<ParamsOf<MessageOf<K>>, string | number>]

/** A key that takes no values: the type for keys kept in a table (a list of
 *  tabs, a set of options) and looked up later, where the key is not a
 *  literal and its placeholders could not be checked. */
export type PlainMessageKey = { [K in MessageKey]: [ParamsOf<MessageOf<K>>] extends [never] ? K : never }[MessageKey]

export type Translate = <K extends MessageKey>(key: K, ...vars: VarsArg<K>) => string

const catalogs: Record<Locale, Catalog> = { en, 'pt-BR': ptBR }

type Vars = Record<string, string | number>

function lookup(catalog: Catalog, key: string): Message | undefined {
  const dot = key.indexOf('.')
  const namespace: Record<string, Message> | undefined = catalog[key.slice(0, dot) as Namespace]
  return namespace?.[key.slice(dot + 1)]
}

function pick(message: Message, locale: Locale, vars: Vars | undefined): string {
  if (typeof message === 'string') return message
  const count = Number(vars?.count ?? 0)
  return new Intl.PluralRules(locale).select(count) === 'one' ? message.one : message.other
}

function fill(text: string, vars: Vars | undefined): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

/** The message for `key` in `locale`, falling back to English and then to the
 *  key itself, so a gap shows up as readable text rather than a blank. */
export function translateIn(locale: Locale, key: MessageKey, vars?: Vars): string {
  const message = lookup(catalogs[locale], key) ?? lookup(en, key)
  if (message === undefined) return key
  return fill(pick(message, locale, vars), vars)
}

/** Translates in the active language. For code outside React; a component
 *  uses `useT` so it re-renders when the language changes. */
export const t: Translate = (key, ...vars) => translateIn(getLocale(), key, vars[0])

/* one translator per language, so the function useT hands out stays the same
   across renders and is safe in an effect's or callback's dependencies */
const translators = new Map<Locale, Translate>()

function translatorFor(locale: Locale): Translate {
  let translator = translators.get(locale)
  if (!translator) {
    translator = (key, ...vars) => translateIn(locale, key, vars[0])
    translators.set(locale, translator)
  }
  return translator
}

/** The translator for the active language; re-renders on a language switch.
 *  The same function comes back until the language changes. */
export function useT(): Translate {
  const { locale } = useLocale()
  return translatorFor(locale)
}
