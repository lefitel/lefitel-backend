// The passkey router. `docs/plans/2026-09-02-passkeys-4c.md`, phase 1.
//
// 🔴 **The path segments here are a hard contract with `auth/sessionState.ts`,
// not a naming preference.** That file already reserves three prefixes for
// routes that did not exist when it was written:
//
//     PARCIAL:           /api/auth/webauthn/login
//     ONBOARDING_EXTRA:  /api/auth/webauthn/register
//                        /api/auth/webauthn/credentials
//
// `coincide` matches on equality or prefix-with-slash, so mounting this router
// anywhere else — `/api/auth/passkeys`, or a route named
// `/webauthn/register-options` with a hyphen — does not produce an error. It
// produces a **loop**: an `onboarding` session gets 403 `FACTOR_PENDIENTE`,
// the client's interceptor shows a toast pointing at the very screen the
// person is already on, and there is no door in the API that opens.
//
// 🔴 **And the dangerous mistake is the opposite one.** Widening the `PARCIAL`
// entry to the whole `/api/auth/webauthn` prefix — the obvious "simplification"
// once this router is mounted at that path — would open `register` to a
// session that has proved nothing but a password. From `totp.routes.ts`, which
// carries the same warning for the same reason: that caller registers their
// own factor, and from that instant the real owner's next login opens
// `parcial`, escapable only by proving the **attacker's** credential. Changing
// the password does not help and `logout-all` revokes sessions, not
// credentials. The rule: `PARCIAL` may gain what *proves* an existing factor,
// never what *creates* one.
//
// 🔴 **Both registration routes take the ten-minute window — decision of
// 2026-10-10 (Isaias, risks put to him twice).** On a route that registers or
// removes a credential the window is a way in: a stolen cookie waits for the
// owner to prove a factor for something ordinary, then registers its own key
// inside those minutes without typing anything — which ends in the permanent
// lockout the paragraph above describes. These routes used to demand the
// caller's password on every request (`sinVentana`), the one thing the cookie
// does not carry; that option is gone. The lockout is now an accepted cost for
// the length of a window, not a property the gate prevents.
//
// **`permiteOnboarding: true` for the same reason `totp.routes.ts` has it**:
// this is the screen somebody in `onboarding` has to reach in order to stop
// being in `onboarding`. A gate that refused them would close the only exit.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireStepUp } from "../middleware/requireStepUp.js";
import { webauthnCeremonyLimiter } from "../middleware/loginLimiters.js";
import {
  registerOptions,
  registerVerify,
  loginOptions,
  loginVerify,
  listCredentials,
  deleteCredential,
} from "../controllers/webauthn.controller.js";

const router = Router();

/**
 * Proving a passkey that already exists — **and these two carry no
 * `requireStepUp`, by construction rather than by omission.**
 *
 * A `parcial` session is what calls them: somebody who has given a password
 * and has not yet proved a factor. `requireStepUp` refuses `parcial` flat, with
 * options or without them, so mounting it here would close the only door out
 * of that state. These are the gate, not what sits behind it — exactly the
 * argument `mfa.routes.ts` already makes for `/api/auth/mfa/verify`.
 *
 * 🔴 **And that is why the path may not gain a sibling.** `sessionState.ts`
 * opens the whole `/api/auth/webauthn/login` prefix to `parcial`, so anything
 * mounted under it is reachable by a caller holding nothing but a password.
 * Only the two below belong here.
 *
 * 🔴 **A failed assertion deliberately costs nothing against the account
 * lockout — so `webauthnCeremonyLimiter` is what bounds this pair, and it is
 * not optional.** An earlier version of this comment claimed the single-use
 * challenge was enough: *"every attempt needs a fresh challenge, and each
 * challenge is spent by the attempt that uses it"*. That is false for the two
 * cheapest refusals. A body with no assertion in it, and a credential that is
 * not this account's, both return **before** a challenge is ever looked at —
 * and each of them writes a bitácora row. With no bucket, one stolen cookie is
 * an unbounded INSERT primitive into the one table nothing here ever prunes,
 * which would drown the very signal those rows exist to give.
 *
 * Mounted after `authenticate` because the bucket is keyed by session, which
 * is what a stolen cookie is. Counting successes too — see the limiter's own
 * note: this one bounds writing, not guessing.
 */
router.post("/login/options", authenticate, webauthnCeremonyLimiter, loginOptions);
router.post("/login/verify", authenticate, webauthnCeremonyLimiter, loginVerify);

router.post(
  "/register/options",
  authenticate,
  requireStepUp({ permiteOnboarding: true }),
  registerOptions,
);

router.post(
  "/register/verify",
  authenticate,
  requireStepUp({ permiteOnboarding: true }),
  registerVerify,
);

/**
 * Managing the keys already registered — plan 4C, Task 9.
 *
 * **The prefix is the contract again.** `sessionState.ts` reserves
 * `/api/auth/webauthn/credentials` in `ONBOARDING_EXTRA`, so these two are
 * reachable by `onboarding` and by `completa` and **not** by `parcial` — which
 * is right in both directions. Somebody still finishing their setup has to be
 * able to see and tidy the keys they are registering; somebody holding nothing
 * but a password may not so much as enumerate them.
 *
 * 🔴 **The list carries no `requireStepUp`, the deletion carries the plain
 * gate.** Reading your own key names is not a sensitive write and gating it
 * would put a ceremony in front of the screen that *shows* you what to prove
 * with. Removing one is the mirror of registering one — it changes what the
 * account can prove with — so it takes the same gate and the same window as
 * the registration routes, with the same accepted cost (decision of
 * 2026-10-10): inside the window a hijacked session can delete the owner's key.
 *
 * **And it does not lock anybody out**, which is the question this mount has to
 * answer. An account whose only factor is the key it wants to delete is refused
 * `sin-factor-reciente` with `metodos: ["passkey", …]`, so the window knows to
 * offer the fingerprint. The person proves the key at `/webauthn/login/verify`
 * and the deletion goes through. Without that field the window would have drawn
 * a six-digit box they could never fill.
 */
router.get("/credentials", authenticate, listCredentials);

router.delete(
  "/credentials/:id",
  authenticate,
  requireStepUp({ permiteOnboarding: true }),
  deleteCredential,
);

export default router;
