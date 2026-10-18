/**
 * Fixed native mailbox IDs. Dependency-free so domains.ts and mailboxes.ts
 * can both import it.
 *
 * ADMIN_MAILBOX_ID is admin@<main mail domain>: the administrator's own inbox,
 * created by first-run setup (or on upgrade), opened only with the owner
 * session, and never deletable.
 *
 * LEGACY_MAILBOX_ID is the single mailbox of a v2 install, or the address
 * chosen at setup before v3.08. It is now an ordinary mailbox; the ID only
 * matters for detecting a v2 upgrade and for its connected_accounts row.
 */
export const ADMIN_MAILBOX_ID = "native:admin";
export const LEGACY_MAILBOX_ID = "native:primary";

export const adminMailboxAddressFor = (domain: string) => `admin@${domain.toLowerCase()}`;
