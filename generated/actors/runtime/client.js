import { ActorInvocationError, ActorProtocolError } from "./errors.js";
import { connectionRefused, isRecord, parseActorHostReply, responseDocument } from "./http.js";
import { cloneJson } from "./json.js";
import { authorizationHeaders, configuredSettings, environmentSettings, projectActorPath, runtimeEnvironment, validateActorComponent } from "./settings.js";
import { LatencyTimeline } from "./telemetry.js";
export class HttpActorClient {
    settingsValue;
    environment;
    fetchRequest;
    requestId;
    monotonicNow;
    telemetry;
    constructor(options, dependencies = {}) {
        this.environment = dependencies.environment ?? runtimeEnvironment();
        this.fetchRequest = dependencies.fetch ?? globalThis.fetch;
        this.requestId = dependencies.requestId ?? (() => globalThis.crypto.randomUUID());
        this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
        this.telemetry = dependencies.telemetry ?? (() => { });
        this.settingsValue = options === undefined ? undefined : configuredSettings(options);
    }
    async invoke(actorName, actorId, method, args) {
        const requestId = validateActorComponent("request ID", this.requestId());
        const timeline = new LatencyTimeline(this.monotonicNow);
        let outcome = "failed";
        try {
            const invocation = this.invocation(requestId, actorName, actorId, method, args);
            timeline.mark("invocation_built");
            const result = await this.invokeAttempt(invocation, true, timeline);
            outcome = "completed";
            return result;
        }
        finally {
            this.telemetry({
                event: "actor_client_invocation",
                request_id: requestId,
                actor_name: actorName,
                actor_id: actorId,
                method,
                ...timeline.finish(),
                outcome
            });
        }
    }
    async invokeAttempt(invocation, retryAvailable, timeline) {
        const reply = await this.resolveAndInvoke(invocation);
        timeline.mark("control_plane_invocation_completed");
        if (reply.type === "completed")
            return reply.result;
        if (reply.type === "failed")
            throw new ActorInvocationError(reply.code, invocation.requestId, reply.message);
        if (!retryAvailable)
            throw new ActorInvocationError(reply.type === "unauthenticated" ? "unauthenticated" : "unavailable", invocation.requestId, "actor host rejected the invocation before execution after recovery");
        return this.invokeAttempt(invocation, false, timeline);
    }
    async resolveAndInvoke(invocation) {
        let response;
        try {
            response = await this.fetchRequest(`${this.settings.controlPlaneUrl}${projectActorPath(this.settings.projectId, invocation.actorName, invocation.actorId)}/invoke`, {
                method: "POST",
                redirect: "manual",
                headers: {
                    accept: "application/json",
                    ...authorizationHeaders(this.settings.credential),
                    "x-request-id": invocation.requestId,
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    requestId: invocation.requestId,
                    method: invocation.method,
                    args: invocation.args,
                    homeRegion: this.settings.homeRegion
                })
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (connectionRefused(error))
                throw new ActorInvocationError("unavailable", invocation.requestId, `could not connect to ${this.settings.controlPlaneUrl}: ${message}`);
            throw new ActorInvocationError("outcome_unknown", invocation.requestId, `control-plane invocation failed after it may have been dispatched: ${message}`);
        }
        const document = await responseDocument(response);
        if (!response.ok)
            this.throwResponseFailure(response, document, invocation.requestId);
        if (!isRecord(document))
            throw new ActorProtocolError("control-plane response did not contain an invocation outcome");
        const reply = isRecord(document.outcome) && document.outcome.type === "unauthenticated"
            ? { type: "unauthenticated" }
            : parseActorHostReply(document.outcome);
        return reply;
    }
    throwResponseFailure(response, document, requestId) {
        if (response.status === 401 || response.status === 403)
            throw new ActorInvocationError("unauthenticated", requestId, "the durable-actors application credential was rejected");
        const failure = isRecord(document) ? document.error : undefined;
        if (!isRecord(failure) ||
            typeof failure.code !== "string" ||
            !failure.code ||
            typeof failure.message !== "string")
            throw new ActorProtocolError(`control-plane HTTP ${response.status} response did not contain a valid error`);
        throw new ActorInvocationError(failure.code, typeof failure.requestId === "string" ? failure.requestId : requestId, failure.message);
    }
    invocation(requestId, actorName, actorId, method, args) {
        return {
            requestId,
            projectId: this.settings.projectId,
            actorName: validateActorComponent("actor name", actorName),
            actorId: validateActorComponent("actor ID", actorId),
            method: validateActorComponent("actor method", method),
            args: this.jsonArguments(args)
        };
    }
    get settings() {
        if (this.settingsValue !== undefined)
            return this.settingsValue;
        this.settingsValue = configuredSettings(environmentSettings(this.environment));
        return this.settingsValue;
    }
    jsonArguments(args) {
        const value = cloneJson(args, "actor arguments");
        if (!Array.isArray(value))
            throw new ActorProtocolError("actor arguments must be a JSON array");
        return value;
    }
}
