import { configuredSettings } from "./settings.js";
import type { DurableActorsClientOptions, Environment } from "./settings.js";
import type { TelemetrySink } from "./telemetry.js";
export declare class HttpActorClient {
    private settingsValue;
    protected readonly environment: Environment;
    protected readonly fetchRequest: typeof globalThis.fetch;
    protected readonly requestId: () => string;
    protected readonly monotonicNow: () => number;
    protected readonly telemetry: TelemetrySink;
    constructor(options?: DurableActorsClientOptions, dependencies?: HttpActorClientDependencies);
    invoke(actorName: string, actorId: string, method: string, args: readonly unknown[]): Promise<unknown>;
    private invokeAttempt;
    private resolveAndInvoke;
    private throwResponseFailure;
    private invocation;
    protected get settings(): RemoteActorSettings;
    private jsonArguments;
}
type RemoteActorSettings = ReturnType<typeof configuredSettings>;
export interface HttpActorClientDependencies {
    readonly environment?: Environment;
    readonly fetch?: typeof globalThis.fetch;
    readonly requestId?: () => string;
    readonly monotonicNow?: () => number;
    readonly telemetry?: TelemetrySink;
}
export type { DurableActorsClientOptions };
