import type { AppearanceConfiguration } from "@leaflogue/contracts";

export class AppearanceLiveState {
  #active: AppearanceConfiguration | undefined;
  #problem: string | undefined;

  describe(initial: AppearanceConfiguration): AppearanceConfiguration {
    if (!this.#active) {
      this.#active = usable(initial);
      this.#problem = initial.problem;
    }
    return this.#current();
  }

  reload(candidate: AppearanceConfiguration): { readonly configuration: AppearanceConfiguration; readonly activate: boolean } {
    if (candidate.problem) {
      this.#problem = candidate.problem;
      if (!this.#active) this.#active = usable(candidate);
      return { configuration: this.#current(), activate: false };
    }
    this.#active = usable(candidate);
    this.#problem = undefined;
    return { configuration: this.#current(), activate: true };
  }

  save(configuration: AppearanceConfiguration): AppearanceConfiguration {
    this.#active = usable(configuration);
    this.#problem = configuration.problem;
    return this.#current();
  }

  #current(): AppearanceConfiguration {
    if (!this.#active) throw new Error("Appearance state has not been initialized");
    return { ...this.#active, ...(this.#problem ? { problem: this.#problem } : {}) };
  }
}

function usable(configuration: AppearanceConfiguration): AppearanceConfiguration {
  return { themeId: configuration.themeId, mode: configuration.mode, themes: configuration.themes };
}
