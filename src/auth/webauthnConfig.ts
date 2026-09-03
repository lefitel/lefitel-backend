import { webauthnRpId, webauthnOrigins } from "../config/security.js";

/**
 * The relying party id and the origins every WebAuthn ceremony is checked
 * against, resolved **once per request rather than at module load**, so a
 * test can set the environment before calling and production reads what
 * Coolify actually provided. One function for the two controllers — the
 * authenticated ceremonies of phase 1 and the passwordless door of phase 2 —
 * because an `rpID` computed in two places is an `rpID` that can differ in
 * one of them, and a credential registered under one value never verifies
 * under the other.
 */
export function configuracionWebauthn(): { rpID: string; origenes: string[] } {
  return {
    rpID: webauthnRpId(process.env.WEBAUTHN_RP_ID, process.env.NODE_ENV),
    origenes: [...webauthnOrigins(process.env.WEBAUTHN_ORIGIN, process.env.NODE_ENV)],
  };
}
