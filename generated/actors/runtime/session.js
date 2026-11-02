import { HttpActorClient } from "./client.js";
import { ActorSessionRejectedError } from "./errors.js";
import { validateActorComponent, validateOrigin } from "./settings.js";
export { ActorSessionRejectedError } from "./errors.js";
/**
 * Reuses actor targets and renews runtime-issued sessions through a trusted backend.
 * Sessions require an HTTPS origin (except localhost) and at most five minutes of validity.
 * Renewal stops after a minute without invocations; dispose cancels it immediately.
 */
export class ActorSessionTransport {
    options;
    transport;
    expiresAtMs = 0;
    lastUsedAt = 0;
    pending;
    cancel;
    closed = false;
    now;
    createTransport;
    schedule;
    constructor(options, dependencies = {}) {
        this.options = options;
        validateActorComponent("project ID", options.projectId);
        this.now = dependencies.now ?? (() => performance.timeOrigin + performance.now());
        this.createTransport = dependencies.createTransport ?? (settings => new HttpActorClient(settings));
        this.schedule = dependencies.schedule ?? scheduleRefresh;
    }
    async invoke(actorName, actorId, method, args) {
        if (this.closed)
            throw new Error("Actor session transport is disposed");
        this.lastUsedAt = this.now();
        const transport = this.transport && this.expiresAtMs > this.now() + 5_000 ? this.transport : await this.refresh();
        return transport.invoke(actorName, actorId, method, args);
    }
    dispose() {
        this.closed = true;
        this.cancel?.();
        this.transport = undefined;
    }
    refresh() {
        if (this.pending)
            return this.pending;
        this.cancel?.();
        this.pending = this.exchange().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }
    async exchange() {
        let session;
        try {
            session = await this.options.getSession();
        }
        catch (error) {
            if (error instanceof ActorSessionRejectedError) {
                this.transport = undefined;
                this.expiresAtMs = 0;
            }
            throw error;
        }
        const remaining = this.validateSession(session);
        if (this.closed)
            throw new Error("Actor session transport is disposed");
        const transport = this.createTransport({
            projectId: session.projectId,
            controlPlaneUrl: session.controlPlaneUrl,
            apiKey: session.token
        });
        this.transport = transport;
        this.expiresAtMs = session.expiresAtMs;
        this.scheduleRenewal(remaining * (0.75 + Math.random() * 0.05));
        return transport;
    }
    validateSession(session) {
        if (!session ||
            session.projectId !== this.options.projectId ||
            typeof session.token !== "string" ||
            !session.token.trim() ||
            !Number.isSafeInteger(session.expiresAtMs))
            throw new Error("Invalid actor session");
        const origin = new URL(validateOrigin(session.controlPlaneUrl));
        if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
            throw new Error("Actor sessions require HTTPS outside localhost");
        const remaining = session.expiresAtMs - this.now();
        if (remaining <= 5_000 || remaining > 305_000)
            throw new Error("Actor session is expired or invalid");
        return remaining;
    }
    scheduleRenewal(delayMs) {
        this.cancel = this.schedule(() => {
            if (this.closed || this.now() - this.lastUsedAt >= 60_000)
                return;
            void this.refresh().catch(() => {
                if (!this.closed && this.expiresAtMs > this.now() + 5_000)
                    this.scheduleRenewal(5_000);
            });
        }, delayMs);
    }
}
export function createActorSessionTransport(options) {
    return new ActorSessionTransport(options);
}
function scheduleRefresh(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
}
