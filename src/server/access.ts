/**
 * Who may connect to the hosted server.
 *
 * Kept out of worker.ts so it can be tested under Node: worker.ts imports
 * `cloudflare:workers` and cannot be loaded outside the Workers runtime. The
 * rule about who gets into somebody's Splitwise account is the last thing that
 * should be untestable.
 */

export interface AccessConfig {
  /** Empty for nobody, `*` for anyone, or a comma-separated list of addresses and `@domain` entries. */
  ALLOWED_EMAILS: string;
}

/**
 * Who may connect.
 *
 * Empty means nobody, which is the safe default and what an unconfigured
 * deployment does. A single `*` opens it to anyone. Otherwise it is a
 * comma-separated list of exact addresses, or `@domain` entries matching
 * everyone at that domain.
 *
 * Opening it is a deliberate word in a secret rather than an empty value,
 * because "I cleared the config" and "I meant to let the world in" should not
 * look the same.
 */
export function allowed(env: AccessConfig, email: string): boolean {
  const list = new Set(
    (env.ALLOWED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (list.has('*')) return true;
  const address = email.toLowerCase();
  const domain = address.slice(address.indexOf('@'));
  return list.has(address) || list.has(domain);
}

export function isOpen(env: AccessConfig): boolean {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes('*');
}
