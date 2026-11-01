import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { CliError, entry } from './runtime.mjs'

function execute(command, args) {
  const result = spawnSync(command, args, { windowsHide: true, stdio: 'pipe' })
  if (result.error || result.status !== 0)
    throw new CliError('Could not update login startup registration. Check your user service-manager permissions.')
}
const xml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const winArg = (value) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'

/** Register or remove current-user login startup, with no machine-wide privileges. */
export function autostart(directory, install) {
  const runner = path.join(path.dirname(entry), 'service-runner.mjs')
  const id = `doop-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`
  if (process.platform === 'win32') {
    if (!install) {
      execute('schtasks.exe', ['/Delete', '/TN', id, '/F'])
      return
    }
    const user = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true })
    if (user.status !== 0) throw new CliError('Cannot resolve the current Windows account for login startup.')
    const file = path.join(directory, 'service-task.xml')
    const args = [runner, directory].map(winArg).join(' ')
    writeFileSync(
      file,
      `\uFEFF<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user.stdout.trim())}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user.stdout.trim())}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions></Task>`,
      'utf16le',
    )
    execute('schtasks.exe', ['/Create', '/TN', id, '/XML', file, '/F'])
    return
  }
  if (process.platform === 'darwin') {
    const folder = path.join(homedir(), 'Library/LaunchAgents')
    const file = path.join(folder, `${id}.plist`)
    const domain = `gui/${process.getuid()}`
    if (!install) {
      execute('launchctl', ['bootout', `${domain}/${id}`])
      rmSync(file, { force: true })
      return
    }
    mkdirSync(folder, { recursive: true })
    const args = [process.execPath, runner, directory].map((value) => `<string>${xml(value)}</string>`).join('')
    writeFileSync(
      file,
      `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/></dict></plist>`,
    )
    try {
      execute('launchctl', ['bootstrap', domain, file])
    } catch (cause) {
      rmSync(file, { force: true })
      throw cause
    }
    return
  }
  const folder = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'systemd/user')
  const file = path.join(folder, `${id}.service`)
  if (!install) {
    execute('systemctl', ['--user', 'disable', id])
    rmSync(file, { force: true })
    execute('systemctl', ['--user', 'daemon-reload'])
    return
  }
  mkdirSync(folder, { recursive: true })
  const quote = (value) =>
    '"' +
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('%', '%%')
      .replaceAll('$', '$$') +
    '"'
  writeFileSync(
    file,
    `[Unit]\nDescription=Doop local background server\n[Service]\nType=simple\nExecStart=${[process.execPath, runner, directory].map(quote).join(' ')}\n[Install]\nWantedBy=default.target\n`,
  )
  execute('systemctl', ['--user', 'daemon-reload'])
  execute('systemctl', ['--user', 'enable', id])
}
