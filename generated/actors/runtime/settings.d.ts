export interface DurableActorsClientOptions {
    readonly projectId?: string;
    readonly apiKey?: string;
    readonly homeRegion?: string;
    readonly controlPlaneUrl: string;
}
export type Environment = Record<string, string | undefined>;
export declare function configuredSettings(value: unknown): {
    projectId: string;
    credential: string | undefined;
    homeRegion: string | undefined;
    controlPlaneUrl: string;
};
export declare function environmentSettings(environment?: Environment): DurableActorsClientOptions;
export declare function runtimeEnvironment(): Environment;
export declare function validateOrigin(origin: string): string;
export declare function validateActorComponent(name: string, value: string): string;
export declare function projectActorPath(projectId: string, actorName: string, actorId: string): string;
export declare function authorizationHeaders(credential: string | undefined): Record<string, string>;
