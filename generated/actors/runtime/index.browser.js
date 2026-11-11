const createActorStub = () => {
    throw new Error("actors must be used on the server");
};
const createActorTransport = () => {
    throw new Error("actors must be used on the server");
};
const createActorSessionTransport = () => {
    throw new Error("actors must be used on the server");
};
const SocketProxy = class {
    constructor() {
        throw new Error("ActorProxy must be used on the server");
    }
};
export { createActorStub, createActorTransport, createActorSessionTransport, SocketProxy };
export { ActorInvocationError, ActorSessionRejectedError } from "./errors.js";
