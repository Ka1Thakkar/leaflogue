import { ServerError } from "./errors";

/**
 * Checks for request arguments, the counterpart of Convex's validators.
 * Objects refuse unknown fields, so a client cannot pass anything the
 * function does not expect (such as an import-only note origin).
 */
export type Check<T> = (value: unknown, path: string) => T;
export type Checked<C> = C extends Check<infer T> ? T : never;

const invalid = (path: string) => new ServerError("LEAFLOGUE_REQUEST_INVALID", `Argument ${path} is invalid`);

export const string = (maxLength = 1_000_000): Check<string> => (value, path) => {
  if (typeof value !== "string" || value.length > maxLength) throw invalid(path);
  return value;
};

export const number: Check<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(path);
  return value;
};

export const boolean: Check<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw invalid(path);
  return value;
};

export const literal = <const T extends string>(...options: readonly T[]): Check<T> => (value, path) => {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw invalid(path);
  return value as T;
};

export const optional = <T>(check: Check<T>): Check<T | undefined> & { readonly optional: true } =>
  Object.assign((value: unknown, path: string) => value === undefined ? undefined : check(value, path), { optional: true as const });

export const nullable = <T>(check: Check<T>): Check<T | null> => (value, path) => value === null ? null : check(value, path);

export const array = <T>(check: Check<T>, maxItems = 1_000): Check<T[]> => (value, path) => {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(path);
  return value.map((item, index) => check(item, `${path}[${index}]`));
};

type Shape = Record<string, Check<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { readonly optional: true } ? K : never }[keyof S];
export type ObjectOf<S extends Shape> =
  { readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Checked<S[K]> } &
  { readonly [K in OptionalKeys<S>]?: Exclude<Checked<S[K]>, undefined> };

export const object = <S extends Shape>(shape: S): Check<ObjectOf<S>> => (value, path) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(path);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) throw invalid(`${path}.${key}`);
  const result: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(shape)) {
    const checked = check(input[key], `${path}.${key}`);
    if (checked !== undefined) result[key] = checked;
  }
  return result as ObjectOf<S>;
};

export const paginationOpts = object({
  numItems: number,
  cursor: nullable(string(4_096)),
  endCursor: optional(nullable(string(4_096))),
  id: optional(number),
  maximumRowsRead: optional(number),
  maximumBytesRead: optional(number),
});
