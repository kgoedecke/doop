import type { DurableActorsClientOptions } from "./settings.js";
import type { ActorRpcTransport } from "./stub.js";
export interface ActorSession {
    readonly projectId: string;
    readonly controlPlaneUrl: string;
    readonly token: string;
    readonly expiresAtMs: number;
}
export interface ActorSessionTransportOptions {
    readonly projectId: string;
    /** Reauthenticate with your application backend. Throw ActorSessionRejectedError on an explicit denial. */
    readonly getSession: () => Promise<ActorSession>;
}
export interface ActorSessionTransportDependencies {
    readonly now?: () => number;
    readonly createTransport?: (options: DurableActorsClientOptions) => ActorRpcTransport;
    readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}
export { ActorSessionRejectedError } from "./errors.js";
/**
 * Reuses actor targets and renews runtime-issued sessions through a trusted backend.
 * Sessions require an HTTPS origin (except localhost) and at most five minutes of validity.
 * Renewal stops after a minute without invocations; dispose cancels it immediately.
 */
export declare class ActorSessionTransport implements ActorRpcTransport {
    private readonly options;
    private transport;
    private expiresAtMs;
    private lastUsedAt;
    private pending;
    private cancel;
    private closed;
    private readonly now;
    private readonly createTransport;
    private readonly schedule;
    constructor(options: ActorSessionTransportOptions, dependencies?: ActorSessionTransportDependencies);
    invoke(actorName: string, actorId: string, method: string, args: readonly unknown[]): Promise<unknown>;
    dispose(): void;
    private refresh;
    private exchange;
    private validateSession;
    private scheduleRenewal;
}
export declare function createActorSessionTransport(options: ActorSessionTransportOptions): ActorSessionTransport;
