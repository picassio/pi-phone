/**
 * Names and values for `~/.ssh/pi-phone_config` (`machines.ts`): a machine's `Host` alias, from its name, and a path as
 * ssh's config reads it.
 */

/**
 * The alias `ssh <alias>` reaches a machine by: its name in letters, digits, `.`, `_` and `-` (others become `-`), lower
 * case; a name two machines share, or one with nothing left, takes the start of its id after it.
 */
export function sshAlias(machine: { id: string; name: string }, all: readonly { id: string; name: string }[]): string {
    const base = (name: string) =>
        name
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "");
    const own = base(machine.name);
    const shared = all.some((other) => other.id !== machine.id && base(other.name) === own);

    return own === "" || shared ? `${own === "" ? "machine" : own}-${machine.id.slice(0, 8)}` : own;
}

/** A value with spaces or quotes, quoted for ssh's config. */
export function quoteConfigValue(value: string): string {
    if (/["\r\n]/.test(value)) {
        throw new Error(`Cannot put ${JSON.stringify(value)} in an ssh config.`);
    }

    return /\s/.test(value) ? `"${value}"` : value;
}
