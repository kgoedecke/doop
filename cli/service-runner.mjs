import { register } from 'tsx/esm/api'
register()
const { runDaemon } = await import('./main.ts')
runDaemon(process.argv[2])
