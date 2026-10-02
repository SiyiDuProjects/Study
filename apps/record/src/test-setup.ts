import { vi } from "vitest";

// Browser layout primitives used by the native HeroUI responsive components.
if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: vi.fn(), removeListener: vi.fn(),
  addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()
})) });
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
