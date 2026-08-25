// The one piece of behaviour this model defines beyond column shape: `email`
// trims and lowercases on write. `Model.build()` only constructs an
// in-memory instance — it issues no query — so this is safe to exercise
// directly against the real model, no mocking required.

import { describe, it, expect } from "vitest";
import { UsuarioModel } from "./usuario.model.js";

describe("UsuarioModel", () => {
  it("lowercases email when it is set, so every write path stores the same casing", () => {
    const usuario = UsuarioModel.build({ email: "Isaias@Osefi.NET" } as never);
    expect(usuario.dataValues.email).toBe("isaias@osefi.net");
  });

  it("trims padding from both ends, not just lowercases", () => {
    // Without the trim, " isaias@x.com " and "isaias@x.com" are two different
    // strings to Postgres: the partial unique index stops catching the same
    // mailbox claimed twice, and whoever typed their address without the
    // stray space later gets no match on `lower(email) = lower($1)` in
    // `/auth/password/forgot` — which answers identically either way, so
    // there is nothing on the outside to say why the reset link never comes.
    const usuario = UsuarioModel.build({ email: "  ISAIAS@Osefi.net  " } as never);
    expect(usuario.dataValues.email).toBe("isaias@osefi.net");
  });

  it("leaves a null or undefined email alone rather than throwing", () => {
    // A brand-new account has no email yet, and a profile update that leaves
    // it out entirely must not crash trying to call .toLowerCase() on
    // undefined.
    const withNull = UsuarioModel.build({ email: null } as never);
    expect(withNull.dataValues.email).toBeNull();

    const withoutIt = UsuarioModel.build({} as never);
    expect(withoutIt.dataValues.email).toBeUndefined();
  });

  it("does not touch email on read: what was stored is what comes back", () => {
    // There is no getter defined at all — this pins that fact so a future
    // edit adding one for symmetry has to do it on purpose, having read the
    // comment on the setter explaining why reads stay untouched.
    const usuario = UsuarioModel.build({ email: "Already@Lower.com" } as never);
    usuario.dataValues.email = "MixedCase@NotNormalised.com";
    expect(usuario.dataValues.email).toBe("MixedCase@NotNormalised.com");
  });
});
