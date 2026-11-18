/**
 * Lightweight typed dependency-injection container.
 *
 * Services are registered under typed {@link Token}s as lazy factories and
 * resolved on demand (singleton per container). Tokens carry their service type
 * via a phantom field so {@link Container.resolve} returns the correct type.
 *
 * Modules never import core service singletons directly — they receive services
 * through this container (via the `useService` hook in components, or the redux
 * thunk `extra` argument in slices / RTK Query baseQueries).
 */

/** A type-safe service token. The `__type` field is phantom (never assigned). */
export type Token<T> = symbol & { readonly __type?: T };

/** Create a typed token. The name is used for debugging and error messages. */
export function token<T>(name: string): Token<T> {
  return Symbol(name) as Token<T>;
}

type Factory<T> = (c: Container) => T;

/**
 * A minimal service container. `register` stores a factory; `resolve`
 * instantiates it once and caches the instance for the container's lifetime.
 */
export class Container {
  private factories = new Map<symbol, Factory<unknown>>();
  private instances = new Map<symbol, unknown>();

  /** Register a lazy factory for a token. Re-registering replaces the factory and clears any cached instance. */
  register<T>(t: Token<T>, factory: Factory<T>): this {
    this.factories.set(t, factory as Factory<unknown>);
    this.instances.delete(t);
    return this;
  }

  /** Register an already-constructed value for a token. */
  registerValue<T>(t: Token<T>, value: T): this {
    this.factories.set(t, () => value);
    this.instances.set(t, value);
    return this;
  }

  /** Resolve a token to its (cached) service instance. Throws if the token was never registered. */
  resolve<T>(t: Token<T>): T {
    if (this.instances.has(t)) {
      return this.instances.get(t) as T;
    }
    const factory = this.factories.get(t);
    if (!factory) {
      throw new Error(
        `[DI] No service registered for token "${t.description ?? String(t)}". ` +
          `Register it in the composition root before resolving.`,
      );
    }
    const instance = factory(this);
    this.instances.set(t, instance);
    return instance as T;
  }

  /** Whether a token has been registered. */
  has<T>(t: Token<T>): boolean {
    return this.factories.has(t);
  }
}
