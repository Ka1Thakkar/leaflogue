import type { Transport } from "../transport/transport";

/** A transport for tests: records every call and answers from canned handlers. */

export interface RecordedCall {
  readonly kind: "query" | "mutation" | "action";
  readonly name: string;
  readonly args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

export class FakeTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  readonly #handlers = new Map<string, Handler>();

  on(name: string, handler: Handler): this {
    this.#handlers.set(name, handler);
    return this;
  }

  called(name: string): RecordedCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  query<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.#call("query", name, args);
  }

  mutation<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.#call("mutation", name, args);
  }

  action<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.#call("action", name, args);
  }

  async #call<T>(kind: RecordedCall["kind"], name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ kind, name, args });
    const handler = this.#handlers.get(name);
    if (!handler) throw new Error(`No fake for ${name}`);
    return await handler(args) as T;
  }
}
