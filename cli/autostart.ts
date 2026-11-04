import { Effect, FileSystem, Path } from 'effect'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { Configuration } from './config.ts'
import { ProcessError, StorageError } from './model.ts'
import { Processes } from './process.ts'

const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const winArg = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'

/** Register or remove only the current user's platform-specific login job. */
export const autostart = Effect.fn('Autostart.configure')(
  function* (install: boolean) {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const processes = yield* Processes
    const execute = Effect.fn('Autostart.execute')(function* (command: string, args: ReadonlyArray<string>) {
      const result = yield* processes.run(command, args)
      if (result.code !== 0)
        return yield* new ProcessError({
          operation: 'autostart',
          message: 'Could not update login startup registration. Check user service-manager permissions.',
        })
      return result.stdout.trim()
    })
    const id = `doop-${createHash('sha256').update(config.directory).digest('hex').slice(0, 12)}`
    const runner = path.join(config.root, 'cli/service-runner.mjs')
    if (config.platform === 'win32') {
      if (!install) {
        yield* execute('schtasks.exe', ['/Delete', '/TN', id, '/F'])
        return
      }
      const user = yield* execute('whoami.exe', [])
      const file = path.join(config.directory, 'service-task.xml')
      const args = [runner, config.directory].map(winArg).join(' ')
      const document = `\uFEFF<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(config.executable)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions></Task>`
      yield* fs.writeFile(file, Buffer.from(document, 'utf16le'))
      yield* execute('schtasks.exe', ['/Create', '/TN', id, '/XML', file, '/F'])
      return
    }
    if (config.platform === 'darwin') {
      const folder = path.join(homedir(), 'Library/LaunchAgents')
      const file = path.join(folder, `${id}.plist`)
      const domain = `gui/${process.getuid?.()}`
      if (!install) {
        yield* execute('launchctl', ['bootout', `${domain}/${id}`])
        yield* fs.remove(file, { force: true })
        return
      }
      yield* fs.makeDirectory(folder, { recursive: true })
      const args = [config.executable, runner, config.directory]
        .map((value) => `<string>${xml(value)}</string>`)
        .join('')
      yield* fs.writeFileString(
        file,
        `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/></dict></plist>`,
      )
      yield* execute('launchctl', ['bootstrap', domain, file]).pipe(
        Effect.onError(() => fs.remove(file, { force: true }).pipe(Effect.ignore)),
      )
      return
    }
    const folder = path.join(config.environment.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'systemd/user')
    const file = path.join(folder, `${id}.service`)
    if (!install) {
      yield* execute('systemctl', ['--user', 'disable', id])
      yield* fs.remove(file, { force: true })
      yield* execute('systemctl', ['--user', 'daemon-reload'])
      return
    }
    yield* fs.makeDirectory(folder, { recursive: true })
    const quote = (value: string) =>
      '"' +
      value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
        .replaceAll('%', '%%')
        .replaceAll('$', '$$') +
      '"'
    yield* fs.writeFileString(
      file,
      `[Unit]\nDescription=Doop local background server\n[Service]\nType=simple\nExecStart=${[config.executable, runner, config.directory].map(quote).join(' ')}\n[Install]\nWantedBy=default.target\n`,
    )
    yield* execute('systemctl', ['--user', 'daemon-reload'])
    yield* execute('systemctl', ['--user', 'enable', id])
  },
  Effect.mapError((error) =>
    error instanceof ProcessError
      ? error
      : new StorageError({ operation: 'autostart', message: 'Cannot write login startup registration.' }),
  ),
)
