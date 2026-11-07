import { ActorProtocolError } from "./errors.js";
export function parseActorHostReply(reply) {
    if (isRecord(reply)) {
        const metadata = parseMetadata(reply);
        if (reply.type === "completed" && Object.hasOwn(reply, "result"))
            return { type: "completed", result: reply.result, ...metadata };
        if (reply.type === "failed" &&
            typeof reply.code === "string" &&
            reply.code.length > 0 &&
            typeof reply.message === "string")
            return { type: "failed", code: reply.code, message: reply.message, ...metadata };
        if (reply.type === "not_executed" && rejectionReason(reply.reason))
            return { type: "not_executed", reason: reply.reason, ...metadata };
    }
    throw new ActorProtocolError("actor host response did not contain a valid outcome");
}
function parseMetadata(reply) {
    if (!Object.hasOwn(reply, "metadata"))
        return {};
    const metadata = reply.metadata;
    if (!isRecord(metadata) ||
        !nonnegativeFiniteNumber(metadata.routingMs) ||
        !nonnegativeFiniteNumber(metadata.durationMs) ||
        (metadata.queueWaitMs !== null &&
            (!nonnegativeFiniteNumber(metadata.queueWaitMs) || metadata.queueWaitMs > metadata.durationMs)) ||
        (metadata.hostState !== "cold" && metadata.hostState !== "warm"))
        throw new ActorProtocolError("actor host response contained invalid latency metadata");
    return {
        metadata: {
            routingMs: metadata.routingMs,
            durationMs: metadata.durationMs,
            queueWaitMs: metadata.queueWaitMs,
            hostState: metadata.hostState
        }
    };
}
function nonnegativeFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function rejectionReason(value) {
    return value === "host_unavailable" || value === "upstream_not_reached";
}
export function connectionRefused(error, ancestors = new Set()) {
    if (!isRecord(error) || ancestors.has(error))
        return false;
    const visited = new Set(ancestors).add(error);
    if (error.code !== undefined && error.code !== "ECONNREFUSED")
        return false;
    if (error.errors !== undefined)
        return (Array.isArray(error.errors) &&
            error.errors.length > 0 &&
            error.errors.every(cause => connectionRefused(cause, visited)));
    if (error.code === "ECONNREFUSED")
        return error.syscall === "connect";
    return connectionRefused(error.cause, visited);
}
export async function responseDocument(response) {
    try {
        return await response.json();
    }
    catch (error) {
        throw new ActorProtocolError(`HTTP ${response.status} response was not valid JSON`, { cause: error });
    }
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
