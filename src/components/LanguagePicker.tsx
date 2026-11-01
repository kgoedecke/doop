import { LOCALES, LOCALE_NAMES, isLocale, useLocale, useT } from '../lib/i18n'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'

/** The chip row on the Appearance settings pane. Each language is named in
 *  itself, so someone who cannot read the current one still finds theirs. */
export function LanguagePicker() {
  const { locale, setLocale } = useLocale()
  const t = useT()
  return (
    <ToggleChipGroup
      aria-label={t('settings.languageAria')}
      value={locale}
      onValueChange={(next) => isLocale(next) && setLocale(next)}
    >
      {LOCALES.map((value) => (
        <ToggleChipItem key={value} value={value} lang={value}>
          {LOCALE_NAMES[value]}
        </ToggleChipItem>
      ))}
    </ToggleChipGroup>
  )
}
