// Centralizes the "required env var or throw" pattern so each lib module
// doesn't reinvent its own validation.

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
