// فهرس المزودين — يربط معرف المزود بالمحوّل المناسب
import type { ProviderId } from "../models";
import { kieAdapter } from "./kie";
import { cometAdapter } from "./cometapi";
import type { ProviderAdapter } from "./types";

export function adapterFor(provider: ProviderId): ProviderAdapter {
  if (provider === "kie") return kieAdapter;
  return cometAdapter;
}

export type { ProviderAdapter, ProviderKey, RawInput, CheckResult } from "./types";
