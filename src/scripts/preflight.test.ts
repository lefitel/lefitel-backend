// The environment is judged before the database is touched.
//
// See the header of `preflight.ts`: with the image migrating and then serving,
// a missing variable used to be discovered by the server — after the
// migrations, which cannot be taken back. These tests hold the two properties
// that make the check worth having: it refuses what `index.ts` would refuse,
// and it goes on refusing the same things as `index.ts` changes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { problemasDeEntorno } from "./preflight.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The six variables production held on 10 October 2026 — and nothing else. */
const PRODUCCION_HOY = {
  NODE_ENV: "production",
  PORT: "3000",
  IMAGES_DIR: "/images",
  JWT_SECRET: "lo-que-fuera",
  CORS_ORIGIN: "https://www.osefi.net",
  DATABASE_URL: "postgres://u:p@db:5432/postgres",
};

/** Everything this version asks for, the way `.env.example` documents it. */
const COMPLETA = {
  ...PRODUCCION_HOY,
  COOKIE_NAME: "__Host-osefi_session",
  COOKIE_SECURE: "true",
  MAIL_PROVIDERS: "resend",
  MAIL_FROM: "avisos@osefi.net",
  RESEND_API_KEY: "re_una_clave",
  MAIL_RESEND_DAILY: "100",
  MFA_ENCRYPTION_KEY_ACTIVE: "1",
  MFA_ENCRYPTION_KEY_1: "a".repeat(64),
  WEBAUTHN_RP_ID: "www.osefi.net",
  WEBAUTHN_ORIGIN: "https://www.osefi.net",
};

describe("problemasDeEntorno", () => {
  it("refuses the environment production has today, and names every variable that is missing", () => {
    // The real case. Deployed as it stood, this version would have migrated
    // the database and then refused to start.
    const problemas = problemasDeEntorno(PRODUCCION_HOY, "production");

    expect(problemas.length).toBeGreaterThan(0);
    const texto = problemas.join("\n");
    for (const variable of [
      "COOKIE_NAME", "COOKIE_SECURE", "MAIL_PROVIDERS", "MAIL_FROM",
      "MFA_ENCRYPTION_KEY_ACTIVE", "WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN",
    ]) {
      expect(texto, variable).toContain(variable);
    }
  });

  it("accepts a complete environment", () => {
    expect(problemasDeEntorno(COMPLETA, "production")).toEqual([]);
  });

  it("refuses a mail chain whose only provider has no credentials", () => {
    // Every required *name* is present, so the list of missing variables is
    // empty — and the server still would not start. This is the refusal a
    // check that only looked at names would miss.
    const { RESEND_API_KEY: _clave, ...sinClave } = COMPLETA;

    const problemas = problemasDeEntorno(sinClave, "production");

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(/cadena de correo está vacía/);
  });

  it("asks for nothing outside production", () => {
    // A laptop with an empty `.env` starts the server; it has to pass here too.
    expect(problemasDeEntorno({}, "development")).toEqual([]);
  });
});

describe("it refuses what index.ts refuses", () => {
  // `index.ts` ends the process with `process.exit(1)` when the configuration
  // will not do. Each of those refusals is decided by a function from
  // `config/security.ts`, and `preflight.ts` has to call every one of them —
  // otherwise the next check added to the boot is one more thing discovered
  // after the migration. Read off the source of both files, because the
  // property is about what the two files *contain*.
  const fuente = (fichero: string) => readFileSync(resolve(here, fichero), "utf-8");
  const index = fuente("../index.ts");
  const preflight = fuente("./preflight.ts");

  /** What `index.ts` imports from `config/security.js`. */
  const importadas = (() => {
    const bloque = /import\s*\{([^}]+)\}\s*from\s*"\.\/config\/security\.js"/.exec(index);
    expect(bloque, "index.ts ya no importa de config/security.js con esta forma").not.toBeNull();
    return bloque![1].split(",").map((n) => n.trim()).filter(Boolean);
  })();

  it("calls every configuration check the boot calls before it can exit", () => {
    // The functions, as opposed to the constants and the timings that arrive
    // through the same import. A name `index.ts` *calls* ahead of its first
    // `sequelize.authenticate()` is a check on the environment.
    const antesDeConectar = index.slice(0, index.indexOf("sequelize.authenticate()"));
    const comprobaciones = importadas.filter((nombre) => new RegExp(`\\b${nombre}\\(`).test(antesDeConectar));

    // The premise, so this cannot pass by finding nothing.
    expect(comprobaciones).toEqual(
      expect.arrayContaining(["requiredEnv", "configuracionDeCorreo", "cookieNameCarriesHostPrefix"]),
    );

    const ausentes = comprobaciones.filter((nombre) => !new RegExp(`\\b${nombre}\\(`).test(preflight));
    expect(
      ausentes,
      `index.ts comprueba esto antes de arrancar y preflight.ts no: ${ausentes.join(", ")}`,
    ).toEqual([]);
  });

  it("runs first in the image's start command, ahead of the migrations", () => {
    const dockerfile = fuente("../../Dockerfile");
    const cmd = dockerfile.split("\n").filter((l) => l.startsWith("CMD ")).pop() ?? "";

    const paso = (fichero: string) => cmd.indexOf(fichero);
    expect(paso("dist/scripts/preflight.js"), cmd).toBeGreaterThan(-1);
    expect(paso("dist/scripts/preflight.js")).toBeLessThan(paso("dist/database/migrate.js"));
    expect(paso("dist/database/migrate.js")).toBeLessThan(paso("dist/index.js"));
  });
});
