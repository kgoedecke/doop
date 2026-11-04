import { Layer } from 'effect'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import { apiLayer } from './auth.ts'
import { configurationLayer } from './config.ts'
import type { Options } from './model.ts'
import { processesLayer } from './process.ts'
import { serverLayer } from './server.ts'
import { serviceManagerLayer } from './service.ts'

/** Assemble the explicit platform/configuration/process/service dependency graph once. */
export function runtimeLayer(options: Options) {
  const platform = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
  const config = configurationLayer(options).pipe(Layer.provide(platform))
  const processes = processesLayer.pipe(Layer.provide([config, platform]))
  const manager = serviceManagerLayer.pipe(Layer.provide([config, processes, platform]))
  const api = apiLayer.pipe(Layer.provide([config, manager, platform]))
  const server = serverLayer.pipe(Layer.provide([config, processes, platform]))
  return Layer.mergeAll(platform, config, processes, manager, api, server)
}
