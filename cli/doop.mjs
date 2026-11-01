#!/usr/bin/env node
import { register } from 'tsx/esm/api'
register()
const { runCli } = await import('./main.ts')
runCli()
