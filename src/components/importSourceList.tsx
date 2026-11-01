import { clientIntegrations } from '@/integrations'
import { GithubIcon, RadioTowerIcon, WebIcon } from './ui/icons'
import type { ImportSource } from './ImportSources'
import { t as translate, type Translate } from '@/lib/i18n'

/** The sources the import picker offers, in order — the canvas page's modal
 *  and Home's Import button show the same cards, so the list lives once. */
export function importSources(t: Translate = translate): ImportSource[] {
  return [
    {
      id: 'website',
      title: t('panels.importWebsite'),
      blurb: t('panels.importWebsiteBlurb'),
      icon: <WebIcon className="size-5 text-ink" />,
    },
    ...clientIntegrations
      .filter((i) => i.ImportSection && i.importSource)
      .map((i) => ({ id: i.id, ...i.importSource! })),
    {
      id: 'liveapp',
      title: t('panels.importLiveApp'),
      blurb: t('panels.importLiveAppBlurb'),
      icon: <RadioTowerIcon className="size-5 text-ink" />,
    },
    {
      id: 'github',
      title: t('panels.importGithub'),
      blurb: t('panels.importGithubBlurb'),
      icon: <GithubIcon width={21} height={21} />,
    },
  ]
}
