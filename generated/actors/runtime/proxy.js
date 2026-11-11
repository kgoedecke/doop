import { ActorProtocolError, ActorSerializationError, ActorValidationError } from "./errors.js";
import { isRecord } from "./http.js";
import { authorizationHeaders, configuredSettings, environmentSettings, projectActorPath, validateActorComponent } from "./settings.js";
/** Issues browser connection URLs from your backend. */
class SocketProxy {
    actors;
    projectId;
    origin;
    apiKey;
    setupTimeoutMs;
    fetchRequest;
    constructor(actors, options = {}, dependencies = {}) {
        this.actors = actors;
        this.setupTimeoutMs = options.setupTimeoutMs ?? 180000;
        if (!Number.isSafeInteger(this.setupTimeoutMs) || this.setupTimeoutMs < 1000 || this.setupTimeoutMs > 600000)
            throw new Error("Socket setup timeout must be between one second and ten minutes");
        const settings = configuredSettings(proxySettings(options));
        this.origin = settings.controlPlaneUrl;
        this.apiKey = settings.credential;
        this.projectId = settings.projectId;
        this.fetchRequest = dependencies.fetch ?? globalThis.fetch;
    }
    /**
     * Call after authenticating the user and checking actor access.
     * Pass `websocketUrl` to the browser's `new WebSocket()`.
     */
    async handle(authorization) {
        const actorName = validateActorComponent("actor name", authorization.actorName);
        const actorId = validateActorComponent("actor ID", authorization.actorId);
        if (!Object.hasOwn(this.actors, actorName))
            throw new Error(`Unknown actor name: ${actorName}`);
        const metadata = socketMetadata(authorization.metadata);
        const homeRegion = authorization.homeRegion === undefined
            ? undefined
            : validateActorComponent("home region", authorization.homeRegion);
        const response = await this.fetchRequest(`${this.origin}${projectActorPath(this.projectId, actorName, actorId)}/find-websocket`, {
            method: "POST",
            redirect: "manual",
            headers: { ...authorizationHeaders(this.apiKey), "content-type": "application/json" },
            body: JSON.stringify({ metadata, homeRegion }),
            signal: AbortSignal.timeout(this.setupTimeoutMs)
        });
        if (!response.ok)
            throw new Error(`WebSocket authorization could not be issued (HTTP ${response.status})`);
        return socketGrant(await response.json());
    }
}
function proxySettings(options) {
    const environment = environmentSettings();
    const controlPlaneUrl = options.controlPlaneUrl ?? environment.controlPlaneUrl;
    const apiKey = options.apiKey ?? environment.apiKey;
    return {
        projectId: options.projectId ?? environment.projectId,
        controlPlaneUrl: controlPlaneUrl ?? "http://127.0.0.1:7100",
        apiKey
    };
}
export { SocketProxy };
function socketGrant(value) {
    if (!isRecord(value) ||
        typeof value.websocketUrl !== "string" ||
        !URL.canParse(value.websocketUrl) ||
        !/^wss?:$/u.test(new URL(value.websocketUrl).protocol) ||
        typeof value.homeRegion !== "string" ||
        !value.homeRegion ||
        !Number.isSafeInteger(value.connectByMs))
        throw new ActorProtocolError("invalid WebSocket authorization response");
    return {
        websocketUrl: value.websocketUrl,
        homeRegion: value.homeRegion,
        connectByMs: value.connectByMs
    };
}
function socketMetadata(value) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
        if (!isJsonValue(value))
            throw new Error("invalid JSON value");
    }
    catch (error) {
        throw new ActorSerializationError("socket metadata must be a JSON value", { cause: error });
    }
    if (new TextEncoder().encode(encoded).length > 16 * 1024)
        throw new ActorValidationError("socket metadata exceeds 16384 bytes");
    return value;
}
function isJsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return Array.from(value).every(isJsonValue);
    return (isRecord(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
        Object.values(value).every(isJsonValue));
}
