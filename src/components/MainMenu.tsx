import { Fragment, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { chordHint, firstChord } from '../lib/actions/chords'
import { ACTIONS, MENUS, isEnabled, runAction, type CanvasAction, type MenuId } from '../lib/actions/registry'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { MenuHint } from './ui/menu'
import { SearchIcon, SparkIcon } from './ui/icons'

/* The rows of one menu, a separator between each section. Rows are read as
   the menu opens (Radix mounts the content then), so what is enabled or
   checked is current. */
function MenuRows({ menu }: { menu: MenuId }) {
  const t = useT()
  const actions = ACTIONS.filter((a) => a.menu === menu)
  const sections = [...new Set(actions.map((a) => a.section))]
  return sections.map((section, i) => (
    <Fragment key={section}>
      {i > 0 && <DropdownMenuSeparator />}
      {actions
        .filter((a) => a.section === section)
        .map((action) => (
          <ActionRow key={action.id} action={action} label={t(action.label)} />
        ))}
    </Fragment>
  ))
}

function ActionRow({ action, label, icon }: { action: CanvasAction; label: string; icon?: ReactNode }) {
  const chord = firstChord(action.keys)
  const hint = chord && <MenuHint>{chordHint(chord)}</MenuHint>
  const disabled = !isEnabled(action)
  if (action.checked) {
    return (
      <DropdownMenuCheckboxItem checked={action.checked()} disabled={disabled} onSelect={() => runAction(action)}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint}
      </DropdownMenuCheckboxItem>
    )
  }
  return (
    <DropdownMenuItem disabled={disabled} onSelect={() => runAction(action)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint}
    </DropdownMenuItem>
  )
}

/**
 * The canvas's main menu, off a button at the bar's left: the action search
 * first, then File, Edit, View, Object, Text, Arrange and Help, each a
 * submenu of the registry's commands with their chords.
 */
export function MainMenu({ trigger }: { trigger: ReactNode }) {
  const t = useT()
  const general = (id: string) => ACTIONS.find((a) => a.id === id)!
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" width="md">
        <ActionRow
          action={general('palette')}
          label={t('actions.palette')}
          icon={<SearchIcon width={14} height={14} aria-hidden className="flex-none text-ink-faint" />}
        />
        {isEnabled(general('ask-agent')) && (
          <ActionRow
            action={general('ask-agent')}
            label={t('actions.askAgent')}
            icon={<SparkIcon width={14} height={14} aria-hidden className="flex-none text-ink-faint" />}
          />
        )}
        <DropdownMenuSeparator />
        {MENUS.map((menu) => (
          <Fragment key={menu.id}>
            {menu.id === 'help' && <DropdownMenuSeparator />}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t(menu.label)}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-[min(300px,calc(100vw-24px))]">
                <MenuRows menu={menu.id} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
