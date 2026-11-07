import { ActorSerializationError } from "./errors.js";
function cloneJson(value, label) {
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined)
            throw new ActorSerializationError(`${label} must be JSON serializable`);
        return JSON.parse(encoded);
    }
    catch (error) {
        if (error instanceof ActorSerializationError)
            throw error;
        throw new ActorSerializationError(`${label} must be JSON serializable`, { cause: error });
    }
}
export { cloneJson };
