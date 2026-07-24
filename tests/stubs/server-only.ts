// vitest cannot resolve the Next.js "server-only" marker package; stubbed so server-only modules
// are importable in tests. The prod guard is unaffected (real "server-only" still resolves in Next.js).
export {};
