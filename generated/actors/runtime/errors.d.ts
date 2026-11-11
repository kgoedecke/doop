declare class ActorConfigurationError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
declare class ActorDefinitionError extends Error {
    constructor(message: string);
}
/** Remote failure. Retrying an `outcome_unknown` operation may run it twice; `unavailable` never ran. */
declare class ActorInvocationError extends Error {
    /** Error category, such as `actor_error` or `outcome_unknown`. New codes may be added. */
    readonly code: string;
    /** Identifies this caller attempt; it is not an application idempotency key. */
    readonly requestId: string;
    constructor(code: string, requestId: string, message: string);
}
/** Signals that the authorization service explicitly revoked or denied access. */
declare class ActorSessionRejectedError extends Error {
    readonly name = "ActorSessionRejectedError";
}
declare class ActorSessionError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
declare class ActorProtocolError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
declare class ActorSerializationError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
declare class ActorValidationError extends Error {
    constructor(message: string);
}
export { ActorConfigurationError, ActorDefinitionError, ActorInvocationError, ActorProtocolError, ActorSerializationError, ActorSessionError, ActorSessionRejectedError, ActorValidationError };
declare function errorMessage(error: unknown): string;
export { errorMessage };
