export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
    readonly [key: string]: JsonValue;
}
