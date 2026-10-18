import { appConfig } from "./appConfig";
import type { AddressRules } from "./mailboxRules";

export type RulesScope = "routing" | "create";

/** Domains addresses may use. v3.00: the primary domain only. */
export async function addressRules(env: Env, _scope: RulesScope = "routing"): Promise<AddressRules> {
  const config = appConfig(env);
  return {
    domains: new Set([config.primaryDomain]),
    defaultDomain: config.primaryDomain,
    adminAddress: config.adminAddress,
  };
}

/** Mailbox that receives postmaster@/abuse@ for a domain. */
export async function postmasterMailboxId(_env: Env, _domain: string): Promise<string> {
  return "native:primary";
}
