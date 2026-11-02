/** Overrides for the backend's DURABLE_ACTORS environment settings. */
interface SocketProxyOptions {
    readonly projectId?: string;
    readonly controlPlaneUrl?: string;
    readonly apiKey?: string;
    /** Defaults to 180000 ms; accepts 1000–600000 ms. */
    readonly setupTimeoutMs?: number;
}
interface SocketProxyDependencies {
    readonly fetch?: typeof globalThis.fetch;
}
interface ProxyActor<Metadata = unknown> {
    readonly types?: Metadata;
}
/** Actor access your backend has already authorized. */
type SocketAuthorization<Actors extends Record<string, ProxyActor>> = {
    [Name in keyof Actors & string]: {
        readonly actorName: Name;
        readonly actorId: string;
        readonly metadata: Actors[Name] extends ProxyActor<infer Metadata> ? Metadata : never;
        readonly homeRegion?: string;
    };
}[keyof Actors & string];
/** Browser connection URL and admission deadline in Unix milliseconds. Treat the URL as a credential. */
interface SocketGrant {
    websocketUrl: string;
    homeRegion: string;
    connectByMs: number;
}
/** Issues browser connection URLs from your backend. */
declare class SocketProxy<Actors extends Record<string, ProxyActor>> {
    private readonly actors;
    private readonly projectId;
    private readonly origin;
    private readonly apiKey;
    private readonly setupTimeoutMs;
    private readonly fetchRequest;
    constructor(actors: Actors, options?: SocketProxyOptions, dependencies?: SocketProxyDependencies);
    /**
     * Call after authenticating the user and checking actor access.
     * Pass `websocketUrl` to the browser's `new WebSocket()`.
     */
    handle(authorization: SocketAuthorization<Actors>): Promise<SocketGrant>;
}
export { SocketProxy };
export type { ProxyActor, SocketAuthorization, SocketGrant, SocketProxyDependencies, SocketProxyOptions };
