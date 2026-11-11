import type { DurableActorsClientOptions } from "./settings.js";
interface ActorRpcTransport {
    invoke(actorName: string, actorId: string, method: string, args: readonly unknown[]): Promise<unknown>;
}
interface ActorRpcMethod {
    readonly name: string;
    readonly result: "void" | "value";
}
/** Creates a backend client from generated method definitions. */
declare function createActorStub<Stub extends object>(actorName: string, actorId: string, methods: readonly ActorRpcMethod[], transport?: ActorRpcTransport): Stub;
export { createActorStub };
export type { ActorRpcMethod, ActorRpcTransport };
export declare function createActorTransport(options: DurableActorsClientOptions): ActorRpcTransport;
export type { DurableActorsClientOptions };
