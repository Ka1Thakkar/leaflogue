import type { LeaflogueBridge } from "@leaflogue/contracts";

declare global {
  interface Window {
    readonly leaflogue: LeaflogueBridge;
  }
}

export {};
