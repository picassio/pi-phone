/**
 * The two tool schema kinds that pi-schema's builders write differently from TypeBox: a string literal and a record.
 * They give the JSON Schema TypeBox gave, so pi-phone's tools kept their schemas when they moved to pi-schema (Pi 1.5).
 */
import type { Annotations, Schema } from "@earendil-works/pi-schema";

/** Exactly `value`, as `{ type: "string" | "number", const }`: pi-schema's `lit` has no `type`. */
export function literal<const V extends string | number>(value: V, options?: Annotations<V>): Schema<V> {
    return { type: typeof value === "number" ? "number" : "string", const: value, ...options } as Schema<V>;
}

/** An object with any string keys and `value` values, as `patternProperties`: pi-schema's `map` uses `additionalProperties`. */
export function record<T>(value: Schema<T>, options?: Annotations<Record<string, T>>): Schema<Record<string, T>> {
    return { type: "object", patternProperties: { "^.*$": value }, ...options } as Schema<Record<string, T>>;
}
