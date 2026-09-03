// The console half of §8's "vía de escape"
// (`docs/specs/2026-08-21-autenticacion-mfa-design.md`) — the thing somebody
// runs inside the production container when the browser button
// (`POST /usuario/:id/mfa/reset`) cannot be reached at all.
//
// **This is not "the second recourse" the design doc's prose suggests — it is
// the only one that always works, and the encargo that wrote this file exists
// specifically to say so.** Pre-audit finding H3
// (`.superpowers/sdd/2026-08-26-esqueleto-mfa/preaudit-via-de-escape.md`)
// measured that the endpoint hangs off `/api/usuario`, which
// `auth/sessionState.ts`'s allow-list does not open for a `parcial` or
// `onboarding` session. An administrator whose own grace period has already
// expired cannot reach the button — not for somebody else's account, and not
// for their own. The third branch of `estadoInicialDeSesion` fires on its own,
// fourteen days after a first login, with nobody touching anything: this is
// the tool for exactly that day.
//
// **A thin wrapper and nothing more.** Every rule that decides what a rescue
// actually *does* — H1's grace that only ever grows, H2's lockout lifted
// alongside the factors, H6-bis's sessions and devices revoked together, the
// notice sent before any write, the bitácora line confirmed outside the
// mutation's transaction — lives once, in `auth/rescueCore.ts`, shared with
// the browser button. Nothing below reimplements any of that; this file only
// does the three things a terminal needs that a plain function cannot:
// parse `process.argv`, name the operator running it, and turn a typed result
// into English^H^H^H^H^H^H^Hcastellano an operator half-asleep at 8am can act
// on without a second lookup.
//
// **Two run commands, and the reason there are two.** `tsx` — what `npm run
// dev` uses everywhere else in this project — is a `devDependency`, and the
// production `Dockerfile` runtime stage does `npm ci --omit=dev`: nothing that
// only `tsx` can run survives the build. Pre-audit finding 3 measured this by
// actually compiling: `tsconfig.json` includes `src/scripts/`, so `npm run
// build` emits `dist/scripts/rescue.js`, and the same Dockerfile stage that
// ships `dist/` also ships `package.json`, which is what makes `npm run
// auth:rescue:deploy` resolve inside the running container.
//
//   npm run auth:rescue        -- --user <usuario> --reset-mfa   (development, via tsx)
//   npm run auth:rescue:deploy -- --user <usuario> --reset-mfa   (the container, via node dist/)
//
// The six operations, one flag each — see `parseArgs` below for why an
// invocation may only ever name one:
//
//   --user <usuario> --reset-mfa
//   --user <usuario> --unlock
//   --user <usuario> --revoke-sessions
//   --user <usuario> --set-email <dirección>
//   --user <usuario> --clear-email
//   --user <usuario> --unarchive
//
// **`--unarchive` reads `--user` the opposite way every other flag does.**
// `resolverCuentaDeRescate` refuses an archived account for the other five,
// which all need a live target — the right call for them, and the reason
// `main()` below cannot simply hand every operation the same resolution
// unconditionally. For `--unarchive` archived is what was typed `--user` to
// find, so `main()` special-cases that one refusal for that one flag rather
// than aborting on it, the console-side twin of the same trap
// `auth/rescueCore.ts` documents on `desarchivarCuentaDeRescate` itself.

import { pathToFileURL } from "node:url";
import { hostname, userInfo } from "node:os";
import { sequelize } from "../database/sequelize.js";
import {
  resolverCuentaDeRescate,
  restablecerSegundoFactor,
  desbloquearCuentaDeRescate,
  revocarSesionesDeRescate,
  establecerEmailDeRescate,
  limpiarEmailDeRescate,
  desarchivarCuentaDeRescate,
  type ActorRescate,
  type ResolucionDeCuenta,
} from "../auth/rescueCore.js";
import { RESCUE_GRACE_HOURS } from "../config/security.js";

/** One rescue operation, and everything it needs beyond the target account. */
export type Operacion =
  | { tipo: "reset-mfa" }
  | { tipo: "unlock" }
  | { tipo: "revoke-sessions" }
  | { tipo: "set-email"; email: string }
  | { tipo: "clear-email" }
  | { tipo: "unarchive" };

export interface ArgsRescate {
  user: string;
  operacion: Operacion;
}

/** How each operation's `tipo` prints back as the flag somebody typed. */
const NOMBRE_DE_FLAG: Record<Operacion["tipo"], string> = {
  "reset-mfa": "--reset-mfa",
  unlock: "--unlock",
  "revoke-sessions": "--revoke-sessions",
  "set-email": "--set-email",
  "clear-email": "--clear-email",
  unarchive: "--unarchive",
};

export const USO = `Uso:
  npm run auth:rescue -- --user <usuario> --reset-mfa
  npm run auth:rescue -- --user <usuario> --unlock
  npm run auth:rescue -- --user <usuario> --revoke-sessions
  npm run auth:rescue -- --user <usuario> --set-email <dirección>
  npm run auth:rescue -- --user <usuario> --clear-email
  npm run auth:rescue -- --user <usuario> --unarchive

En el contenedor de producción, "auth:rescue:deploy" en vez de "auth:rescue".
Exactamente una operación por invocación: --set-email y --reset-mfa juntos se
rechazan a propósito (dos operaciones son dos líneas de bitácora, nunca una).
--unarchive tampoco se combina con ninguna otra: va siempre sola.`;

/**
 * Turns `process.argv.slice(2)` into a validated command, or an error message
 * ready to print as-is.
 *
 * **Exactly one operation flag, always — not only for `--set-email` plus
 * `--reset-mfa`.** Pre-audit finding H4 asked specifically for that pair to be
 * refused: precharging and preverifying a recovery address, in the same breath
 * as wiping the target's factors, is one half of a full account takeover with
 * no password and no factor (`auth/rescueCore.ts`'s own docblock on
 * `establecerEmailDeRescate` spells out the other half). But every one of
 * `rescueCore.ts`'s five operations opens and confirms its own transaction and
 * writes its own bitácora line — there is no combined call — so accepting *any*
 * pair here would mean this script silently ran two separate mutations back to
 * back and called it one command. Requiring exactly one flag closes the whole
 * class at once and happens to be exactly what H4 asked for.
 */
export function parseArgs(argv: string[]): ArgsRescate | { error: string } {
  let user: string | undefined;
  const encontradas: Operacion[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--user": {
        const value = argv[++i];
        if (!value || value.trim() === "" || value.startsWith("--")) {
          return { error: "«--user» necesita un nombre de usuario: --user <usuario>." };
        }
        user = value;
        break;
      }
      case "--reset-mfa":
        encontradas.push({ tipo: "reset-mfa" });
        break;
      case "--unlock":
        encontradas.push({ tipo: "unlock" });
        break;
      case "--revoke-sessions":
        encontradas.push({ tipo: "revoke-sessions" });
        break;
      case "--clear-email":
        encontradas.push({ tipo: "clear-email" });
        break;
      case "--unarchive":
        encontradas.push({ tipo: "unarchive" });
        break;
      case "--set-email": {
        const value = argv[++i];
        if (!value || value.trim() === "" || value.startsWith("--")) {
          return { error: "«--set-email» necesita una dirección: --set-email <dirección>." };
        }
        encontradas.push({ tipo: "set-email", email: value.trim() });
        break;
      }
      default:
        return { error: `argumento no reconocido: "${arg}".` };
    }
  }

  if (!user) return { error: "falta --user <usuario>." };

  if (encontradas.length === 0) {
    return {
      error:
        "falta indicar una operación: --reset-mfa, --unlock, --revoke-sessions, " +
        "--set-email <dirección>, --clear-email o --unarchive.",
    };
  }

  if (encontradas.length > 1) {
    const flags = encontradas.map((o) => NOMBRE_DE_FLAG[o.tipo]);
    if (flags.includes("--set-email") && flags.includes("--reset-mfa")) {
      return {
        error:
          "no se admite --set-email junto con --reset-mfa en la misma invocación: son dos " +
          "operaciones distintas, cada una con su propia línea de bitácora. Ejecútalas por " +
          "separado, una detrás de otra.",
      };
    }
    return { error: `solo se admite una operación por invocación (se indicaron: ${flags.join(", ")}).` };
  }

  return { user, operacion: encontradas[0] };
}

/**
 * Names the operator for the notice email and the bitácora `metadata` —
 * `auth/rescueCore.ts` cannot build this itself, on purpose (see that
 * module's header): it would have to import `node:os` for a value that has no
 * meaning inside an HTTP request, the endpoint's own half of `ActorRescate`.
 *
 * `os.userInfo()` throws on a platform that cannot resolve the running uid —
 * measured to happen in some minimal containers — so a failure here falls
 * back to a label that still identifies *something* rather than crashing a
 * rescue over the one piece of it that is cosmetic.
 */
function actorDeConsola(): ActorRescate {
  let usuarioDelSistema = "desconocido";
  try {
    usuarioDelSistema = userInfo().username;
  } catch {
    // No uid/gid to resolve on this platform. The pid and hostname below
    // still make the line identifiable.
  }
  return {
    descripcion: `consola: ${usuarioDelSistema}@${hostname()} (pid ${process.pid})`,
    ip: null,
  };
}

/**
 * Every arm `resolverCuentaDeRescate` can refuse with, printed the way
 * pre-audit finding H7 asked for: "archivada" gets its own sentence, never
 * folded into "no existe" — that would send whoever is reading this at 8am
 * off hunting for a typo that is not there.
 */
function imprimirResolucionFallida(resolucion: Exclude<ResolucionDeCuenta, { ok: true }>): void {
  if (resolucion.motivo === "archivada") {
    console.error(`Esta cuenta está archivada, desarchívala primero. (@${resolucion.user})`);
    return;
  }
  if (resolucion.motivo === "ambigua") {
    console.error(
      `Ese nombre de usuario coincide con varias cuentas (ids: ${resolucion.ids.join(", ")}). ` +
        "No se ha hecho nada. Vuelve a intentarlo indicando cuál con más precisión, o resuélvelo " +
        "directamente por id.",
    );
    return;
  }
  console.error("No existe ninguna cuenta con ese nombre de usuario.");
}

/**
 * Same "archivada"/"no-encontrada" pair `resolverCuentaDeRescate` can answer,
 * but from *inside* `rescueCore.ts`'s own five operations — `cuentaActivaOrNull`
 * re-checks by id right before mutating. Only reachable if the account changed
 * state in the instant between this script's own resolution above and the
 * call below (archived from another session, or deleted outright); kept
 * distinct from `imprimirResolucionFallida` because this one never has an
 * "ambigua" arm — an id cannot be ambiguous, only a typed name can.
 */
function imprimirRescateFallido(
  resultado: { ok: false; motivo: "no-encontrada" } | { ok: false; motivo: "archivada"; user: string },
): void {
  if (resultado.motivo === "archivada") {
    console.error(`Esta cuenta está archivada, desarchívala primero. (@${resultado.user})`);
    return;
  }
  console.error("La cuenta ya no existe — puede que se haya borrado en este mismo instante.");
}

/**
 * `desarchivarCuentaDeRescate`'s own pair of refusals — kept apart from
 * `imprimirRescateFallido` because "archivada" is not one of them here: for
 * this one operation an archived account is the success case, and the
 * refusal that takes its place is "no-archivada" — a target that exists but
 * was never archived, so there is nothing for `--unarchive` to undo.
 */
function imprimirDesarchivoFallido(
  resultado: { ok: false; motivo: "no-encontrada" } | { ok: false; motivo: "no-archivada"; user: string },
): void {
  if (resultado.motivo === "no-archivada") {
    console.error(`Esa cuenta no está archivada — no hay nada que desarchivar. (@${resultado.user})`);
    return;
  }
  console.error("La cuenta ya no existe — puede que se haya borrado en este mismo instante.");
}

function imprimirAviso(avisoEnviado: boolean): void {
  if (avisoEnviado) {
    console.log("Aviso de seguridad enviado a MAIL_SECURITY_TO.");
  } else {
    console.log(
      "Aviso NO enviado (no hay buzón de seguridad configurado). La línea de bitácora es el " +
        "único registro de esta operación.",
    );
  }
}

async function runResetMfa(id: number, actor: ActorRescate): Promise<number> {
  const resultado = await restablecerSegundoFactor(id, actor);
  // `!== true`, not `!resultado.ok`: see `rescueCore.ts`'s own comment on
  // `ejecutarRescate` for why a negated truthiness check does not narrow a
  // discriminated union under this project's `strictNullChecks: false`, while
  // an explicit equality check does. Same idiom in every `run*` below.
  if (resultado.ok !== true) {
    imprimirRescateFallido(resultado);
    return 1;
  }
  imprimirAviso(resultado.avisoEnviado);
  const { factoresBorrados, sesionesRevocadas, dispositivosRevocados, graceUntil, correoVerificado } =
    resultado.datos;
  console.log(
    `Segundo factor restablecido para @${resultado.cuenta.user}: ` +
      `${factoresBorrados.passkeys} passkey(s), ${factoresBorrados.totp} TOTP y ` +
      `${factoresBorrados.codigos} código(s) de recuperación borrados.`,
  );
  console.log(
    `Bloqueo por intentos fallidos levantado. Sesiones cerradas: ${sesionesRevocadas}. ` +
      `Dispositivos recordados revocados: ${dispositivosRevocados}.`,
  );
  // `graceUntil === null` means this account had never logged in since the
  // deploy — its clock had not started, so the rescue correctly left
  // `mfa_grace_until` untouched instead of stamping 24 hours over the
  // fourteen days its own first login still owes it. See
  // `rescueCore.ts`'s `proximaGraciaDeRescate` for why inventing a deadline
  // here would be worse than not answering at all.
  if (graceUntil === null) {
    console.log(
      "No se tocó su plazo de gracia: esta cuenta todavía no había iniciado sesión desde el " +
        "despliegue, así que sus catorce días completos arrancarán enteros en su primer inicio de sesión.",
    );
  } else {
    console.log(`Gracia concedida hasta ${graceUntil.toISOString()} (nunca menor que la que ya tuviera).`);
  }
  console.log("");
  console.log(`Qué contarle a @${resultado.cuenta.user}:`);
  // Plan 4E: a verified address is a second factor the reset leaves in
  // place, so "solo con su contraseña" is only true for an account without
  // one. For the other, the deadline lines below do not apply either — its
  // next login opens `parcial` and asks for the email code regardless.
  if (correoVerificado) {
    console.log(
      "  - Sigue teniendo su correo verificado como segundo factor: al entrar se le pedirá un código " +
        "enviado a ese correo. No se le pedirá ninguna aplicación ni llave.",
    );
    console.log(
      "  - Si lo que perdió es el acceso a ese buzón, este reset no le sirve: cámbiele la dirección " +
        "con --set-email <dirección> (el código irá a la nueva) o bórresela con --clear-email " +
        "(y entonces entrará solo con su contraseña).",
    );
    console.log("  - Sus sesiones y dispositivos recordados se cerraron: tendrá que iniciar sesión de nuevo en todos sus aparatos.");
    return 0;
  }
  console.log("  - Ya puede entrar solo con su contraseña, sin pedirle ningún segundo factor.");
  if (graceUntil === null) {
    console.log(
      "  - En cuanto entre por primera vez tendrá catorce días completos para configurar un factor " +
        "nuevo, igual que cualquier cuenta que todavía no haya entrado desde el despliegue.",
    );
  } else {
    console.log(
      `  - Tiene hasta ${graceUntil.toISOString()} (${RESCUE_GRACE_HOURS} horas desde ahora, o más si ` +
        "ya le quedaba más) para configurar un factor nuevo antes de que el sistema vuelva a pedírselo.",
    );
  }
  console.log("  - Sus sesiones y dispositivos recordados se cerraron: tendrá que iniciar sesión de nuevo en todos sus aparatos.");
  return 0;
}

async function runUnlock(id: number, actor: ActorRescate): Promise<number> {
  const resultado = await desbloquearCuentaDeRescate(id, actor);
  if (resultado.ok !== true) {
    imprimirRescateFallido(resultado);
    return 1;
  }
  imprimirAviso(resultado.avisoEnviado);
  if (resultado.datos.desbloqueada) {
    console.log(`Bloqueo levantado para @${resultado.cuenta.user}.`);
  } else {
    console.log(`@${resultado.cuenta.user} no tenía ningún bloqueo activo — nada que levantar.`);
  }
  console.log("");
  console.log(`Qué contarle a @${resultado.cuenta.user}: ya puede volver a intentar iniciar sesión.`);
  return 0;
}

async function runRevokeSessions(id: number, actor: ActorRescate): Promise<number> {
  const resultado = await revocarSesionesDeRescate(id, actor);
  if (resultado.ok !== true) {
    imprimirRescateFallido(resultado);
    return 1;
  }
  imprimirAviso(resultado.avisoEnviado);
  const { sesionesRevocadas, dispositivosRevocados } = resultado.datos;
  console.log(
    `Sesiones cerradas: ${sesionesRevocadas}. Dispositivos recordados revocados: ${dispositivosRevocados}. ` +
      `(@${resultado.cuenta.user})`,
  );
  console.log("");
  console.log(
    `Qué contarle a @${resultado.cuenta.user}: tendrá que iniciar sesión de nuevo en todos sus aparatos, ` +
      "con contraseña y, si ya tenía uno registrado, segundo factor.",
  );
  return 0;
}

async function runSetEmail(id: number, email: string, actor: ActorRescate): Promise<number> {
  const resultado = await establecerEmailDeRescate(id, email, actor);

  // `=== true` first, same reasoning as every other `run*` above: it is what
  // leaves `resultado` narrowed to its `ok: false` arms — "no-encontrada",
  // "archivada", *and* this function's own extra "email-en-uso" — for the
  // two checks below.
  if (resultado.ok === true) {
    imprimirAviso(resultado.avisoEnviado);
    console.log(`Dirección de recuperación registrada y marcada como verificada para @${resultado.cuenta.user}: ${email}.`);
    console.log("Cualquier enlace de verificación o de restablecimiento pendiente para esta cuenta quedó invalidado.");
    // Plan 4E, design §1.2.2: said out loud, because from this line on the
    // mailbox behind that address opens the account by itself — password
    // reset and second factor both go through it.
    console.log(
      "ATENCIÓN: esa dirección es ahora, además, el segundo factor de la cuenta. Quien controle ese buzón " +
        "puede restablecer la contraseña y pasar el segundo paso. Esta operación queda en la bitácora y en el aviso de seguridad.",
    );
    console.log("");
    console.log(
      `Qué contarle a @${resultado.cuenta.user}: ya puede usar "olvidé mi contraseña" con esa dirección ` +
        "para volver a entrar, y al entrar se le pedirá un código enviado a ese mismo correo.",
    );
    return 0;
  }

  if (resultado.motivo === "email-en-uso") {
    // H8: the raw Postgres unique-violation `establecerEmailDeRescate` catches
    // internally, surfaced here as one sentence instead of a driver dump —
    // never the "volcado de error de Postgres" the encargo explicitly rules out.
    console.error(
      "Esa dirección ya está verificada en otra cuenta — no se puede usar aquí. Prueba con otra " +
        "dirección, o resuelve primero cuál de las dos cuentas debe conservarla.",
    );
    return 1;
  }

  imprimirRescateFallido(resultado);
  return 1;
}

async function runClearEmail(id: number, actor: ActorRescate): Promise<number> {
  const resultado = await limpiarEmailDeRescate(id, actor);
  if (resultado.ok !== true) {
    imprimirRescateFallido(resultado);
    return 1;
  }
  imprimirAviso(resultado.avisoEnviado);
  console.log(`Dirección de recuperación borrada para @${resultado.cuenta.user}.`);
  console.log("Cualquier enlace de verificación o de restablecimiento pendiente para esta cuenta quedó invalidado.");
  return 0;
}

async function runUnarchive(id: number, actor: ActorRescate): Promise<number> {
  const resultado = await desarchivarCuentaDeRescate(id, actor);
  if (resultado.ok !== true) {
    imprimirDesarchivoFallido(resultado);
    return 1;
  }
  imprimirAviso(resultado.avisoEnviado);
  console.log(`Cuenta desarchivada: @${resultado.cuenta.user}.`);
  console.log("");
  console.log(
    `Qué contarle a @${resultado.cuenta.user}: ya puede volver a iniciar sesión con su contraseña de siempre.`,
  );
  return 0;
}

/**
 * The whole script, as one function returning the process's exit code instead
 * of calling `process.exit` itself — so `run()` below is the only place that
 * decides when the process is actually allowed to end, after `sequelize.close()`.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USO);
    return 0;
  }
  if (argv.length === 0) {
    console.error("Sin argumentos.\n");
    console.error(USO);
    return 1;
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error("");
    console.error(USO);
    return 1;
  }

  const resolucion = await resolverCuentaDeRescate(parsed.user);
  const actor = actorDeConsola();

  // `!== true`, not `!resolucion.ok` — see the note on `runResetMfa` above.
  if (resolucion.ok !== true) {
    // `--unarchive` is the one operation for which an archived account is
    // exactly what `--user` was typed to find, not a refusal —
    // `resolverCuentaDeRescate`'s "archivada" answer exists for the other
    // five operations, which all need a live target. See the module header
    // and `rescueCore.ts`'s own comment on `desarchivarCuentaDeRescate` for
    // the identical trap on the core side of this same door. Every other
    // operation still stops right here, unchanged.
    if (parsed.operacion.tipo === "unarchive" && resolucion.motivo === "archivada") {
      console.log(`Cuenta objetivo: @${resolucion.user} (id ${resolucion.id}) — archivada.`);
      return runUnarchive(resolucion.id, actor);
    }
    imprimirResolucionFallida(resolucion);
    return 1;
  }

  console.log(`Cuenta objetivo: @${resolucion.user} (id ${resolucion.id}).`);

  switch (parsed.operacion.tipo) {
    case "reset-mfa":
      return runResetMfa(resolucion.id, actor);
    case "unlock":
      return runUnlock(resolucion.id, actor);
    case "revoke-sessions":
      return runRevokeSessions(resolucion.id, actor);
    case "set-email":
      return runSetEmail(resolucion.id, parsed.operacion.email, actor);
    case "clear-email":
      return runClearEmail(resolucion.id, actor);
    case "unarchive":
      return runUnarchive(resolucion.id, actor);
  }
}

/**
 * `sequelize.close()` always runs, success or failure — the same reason
 * `database/migrate.ts` has one — because without it the connection pool
 * keeps at least one handle open and the process never exits on its own. In
 * the terminal that reads as the rescue hanging after printing its own
 * success message, with the operator unsure whether it actually finished.
 *
 * Exported so `rescue.test.ts` can call it directly and assert `sequelize.close`
 * ran on both the success path and the thrown-error path — without exporting
 * it, that guarantee would only ever be checked by hand, in a container, which
 * is exactly the kind of thing this file exists to stop being true of.
 */
export async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    // Not a raw stack dump: one sentence an operator can read, with the
    // underlying message attached for whoever has to debug it afterwards.
    console.error(
      "La operación no se completó por un error inesperado:",
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

// Only when executed directly — the same guard `database/migrate.ts` uses and
// for the identical reason: without it, importing this module (from a test,
// say) would run a live rescue as a side effect of the import itself.
const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  void run();
}
