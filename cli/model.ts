import { Schema } from 'effect'

const errorFields = { operation: Schema.String, message: Schema.String }
/** Invalid command or persisted configuration. */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()('ConfigurationError', errorFields) {}
/** Filesystem or lock acquisition failed. */
export class StorageError extends Schema.TaggedError<StorageError>()('StorageError', errorFields) {}
/** A child process could not start, stop or complete its operation. */
export class ProcessError extends Schema.TaggedError<ProcessError>()('ProcessError', errorFields) {}
/** The authenticated local service transport failed. */
export class ControlError extends Schema.TaggedError<ControlError>()('ControlError', errorFields) {}
/** An API request failed without exposing credentials or response payloads. */
export class ApiError extends Schema.TaggedError<ApiError>()('ApiError', {
  ...errorFields,
  status: Schema.optionalKey(Schema.Number),
}) {}
/** User-facing failures accepted at the executable boundary. */
export type CliError = ConfigurationError | StorageError | ProcessError | ControlError | ApiError

/** TCP port, including zero for automatic allocation. */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))
/** Persistent service settings; unknown fields are not exposed by diagnostics. */
export const ServiceSettings = Schema.Struct({ port: Port, installed: Schema.Boolean, autostart: Schema.Boolean })
/** Persistent service settings. */
export type ServiceSettings = Schema.Schema.Type<typeof ServiceSettings>
/** Defaults for a new installation. */
export const defaultSettings: ServiceSettings = { port: 4400, installed: false, autostart: false }
/** Private control registration; the capability is redacted in memory. */
export const Registration = Schema.Struct({
  pid: Schema.Int,
  url: Schema.String,
  socket: Schema.String,
  token: Schema.RedactedFromValue(Schema.String),
})
/** Private control registration. */
export type Registration = Schema.Schema.Type<typeof Registration>
/** Private session cookie, scoped to one exact origin. */
export const Session = Schema.Struct({ origin: Schema.String, cookie: Schema.RedactedFromValue(Schema.String) })
/** Private session cookie. */
export type Session = Schema.Schema.Type<typeof Session>
/** Server signing material; never printed by configuration diagnostics. */
export const LocalAuth = Schema.Struct({
  secret: Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
})
/** Public service response, with no capability or signing material. */
export const ServiceStatus = Schema.Struct({
  running: Schema.Boolean,
  installed: Schema.optionalKey(Schema.Boolean),
  pid: Schema.optionalKey(Schema.Number),
  backendPid: Schema.optionalKey(Schema.Number),
  url: Schema.optionalKey(Schema.String),
  stopping: Schema.optionalKey(Schema.Boolean),
  reloaded: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
})
/** Public service response. */
export type ServiceStatus = Schema.Schema.Type<typeof ServiceStatus>
/** Authenticated control request. */
export const ControlRequest = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.String),
  command: Schema.Literals(['status', 'stop', 'reload']),
})
/** Arbitrary user-owned client configuration with preserved unrelated keys. */
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
/** Existing package metadata needed by the CLI. */
export const PackageMetadata = Schema.Struct({ name: Schema.String, version: Schema.String })
/** CLI values are parsed once at the composition root. */
export interface Options {
  readonly help?: boolean
  readonly version?: boolean
  readonly json?: boolean
  readonly port?: string
  readonly 'data-dir'?: string
  readonly server?: string
  readonly data?: string
  readonly email?: string
  readonly 'password-stdin'?: boolean
  readonly client?: string
  readonly directory?: string
  readonly prefix?: string
  readonly 'dry-run'?: boolean
  readonly autostart?: boolean
  readonly force?: boolean
}
