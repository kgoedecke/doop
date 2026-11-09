class ActorConfigurationError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ActorConfigurationError";
    }
}
class ActorDefinitionError extends Error {
    constructor(message) {
        super(message);
        this.name = "ActorDefinitionError";
    }
}
/** Remote failure. Retrying an `outcome_unknown` operation may run it twice; `unavailable` never ran. */
class ActorInvocationError extends Error {
    /** Error category, such as `actor_error` or `outcome_unknown`. New codes may be added. */
    code;
    /** Identifies this caller attempt; it is not an application idempotency key. */
    requestId;
    constructor(code, requestId, message) {
        super(message);
        this.name = "ActorInvocationError";
        this.code = code;
        this.requestId = requestId;
    }
}
/** Signals that the authorization service explicitly revoked or denied access. */
class ActorSessionRejectedError extends Error {
    name = "ActorSessionRejectedError";
}
class ActorSessionError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ActorSessionError";
    }
}
class ActorProtocolError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ActorProtocolError";
    }
}
class ActorSerializationError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ActorSerializationError";
    }
}
class ActorValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ActorValidationError";
    }
}
export { ActorConfigurationError, ActorDefinitionError, ActorInvocationError, ActorProtocolError, ActorSerializationError, ActorSessionError, ActorSessionRejectedError, ActorValidationError };
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export { errorMessage };
