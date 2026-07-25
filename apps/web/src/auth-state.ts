import type { PublicBootstrap } from "@codex-local-remote/contracts";

export function authenticatedBootstrap(bootstrap: PublicBootstrap): PublicBootstrap {
  return {
    ...bootstrap,
    authenticated: true,
    configured: true,
  };
}

export function loggedOutBootstrap(bootstrap: PublicBootstrap): PublicBootstrap {
  return {
    ...bootstrap,
    authenticated: false,
    configured: true,
  };
}
