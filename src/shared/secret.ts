import { REDACTED } from './redaction.js';

const INSPECT: unique symbol = Symbol.for('nodejs.util.inspect.custom');

/**
 * A credential that never leaks through an accidental log, serialization, or string interpolation.
 *
 * The material is held in a private field, so it is invisible to `Object.keys`, spread, and
 * `util.inspect`'s default object walk. `toJSON` covers `JSON.stringify`, `toString` covers
 * template literals and concatenation, and the Node inspect hook covers `console.log`,
 * `util.inspect`, and `util.format`. Reading the credential requires the explicit `value()` call,
 * which makes every real use of it greppable.
 */
export class Secret {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
  }

  /** The credential itself. Call this only where the secret is actually sent or compared. */
  public value(): string {
    return this.#value;
  }

  public toJSON(): string {
    return REDACTED;
  }

  public toString(): string {
    return REDACTED;
  }

  public [INSPECT](): string {
    return REDACTED;
  }
}
