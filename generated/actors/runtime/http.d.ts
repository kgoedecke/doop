import type { JsonValue } from "./json.js";
export declare function parseActorHostReply(reply: unknown): ActorHostReply;
export declare function connectionRefused(error: unknown, ancestors?: Set<unknown>): boolean;
export declare function responseDocument(response: Response): Promise<unknown>;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export interface ActorAddress {
    readonly projectId: string;
    readonly actorName: string;
    readonly actorId: string;
}
export interface ActorInvocation extends ActorAddress {
    readonly requestId: string;
    readonly method: string;
    readonly args: readonly JsonValue[];
}
type ActorRejectionReason = "host_unavailable" | "upstream_not_reached";
export interface ActorResponseMetadata {
    readonly routingMs: number;
    readonly durationMs: number;
    readonly queueWaitMs: number | null;
    readonly hostState: "cold" | "warm";
}
export type ActorHostReply = ({
    readonly type: "completed";
    readonly result: unknown;
} | {
    readonly type: "failed";
    readonly code: string;
    readonly message: string;
} | {
    readonly type: "unauthenticated";
} | {
    readonly type: "not_executed";
    readonly reason: ActorRejectionReason;
}) & {
    readonly metadata?: ActorResponseMetadata;
};
export {};
