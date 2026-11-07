type JsonPrimitive = string | number | boolean | null;
type JsonObject = {
    readonly [key: string]: JsonValue;
};
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
declare function cloneJson(value: unknown, label: string): JsonValue;
export { cloneJson };
export type { JsonValue };
