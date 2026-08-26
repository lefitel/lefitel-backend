import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The links this API puts inside emails have to land on pages that exist.
 *
 * This test is here because one of them did not, and nothing noticed.
 * `verificationLinkFor` pointed at `/perfil` while `PerfilPage` is nested
 * under `/app` in the frontend's route table, so every verification link ever
 * sent fell through that file's catch-all `<Route path="*">`, and `Navigate`
 * discarded the URL fragment on its way to the home page. No account could
 * ever reach `email_verified_at`. `/password/forgot` only operates on
 * verified addresses, so the entire feature was inert — and inert *quietly*:
 * the send answered 200, the mail arrived, the link opened a page, and the
 * page was the wrong one.
 *
 * The comment on that function had asked whoever built the profile screen to
 * confirm the path. Nobody did. That is what a note addressed to a future
 * reader is worth, and why this is a test instead.
 *
 * **Two repositories, so this is a mirror with a guard**, the same shape as
 * `web/src/lib/password.test.ts` (which reads `PASSWORD_MIN_LENGTH` out of
 * this repo) and `web/src/pages/ResetPasswordPage.test.tsx` (which reads
 * `TOKEN_INVALIDO` out of this one). It can only run where `web` is checked
 * out beside `api`; where it is not — a CI job with one repository — it skips
 * rather than failing, because a guard that cannot see the other side has
 * nothing to say about it.
 */

const REPO_WEB = path.resolve(process.cwd(), "..", "web");
const APP_TSX = path.join(REPO_WEB, "src", "App.tsx");

/**
 * Every path this API writes into an email, and the file that writes it.
 *
 * Read out of the source rather than by calling the functions: both compute
 * their origin from `CORS_ORIGIN` at call time, and what is being checked
 * here is the *path*, which is the literal part.
 */
const ENLACES = [
  { fichero: "src/controllers/email.controller.ts", marca: "#verify_email=", ruta: "/app/perfil" },
  { fichero: "src/controllers/password.controller.ts", marca: "#t=", ruta: "/nueva-contrasena" },
];

describe("the links this API mails point at pages the frontend actually has", () => {
  it("still builds each link from the path this test knows about", () => {
    // Without this, renaming a link's path in the controller would leave the
    // assertions below checking a route nobody links to any more — passing,
    // and meaning nothing.
    for (const { fichero, marca, ruta } of ENLACES) {
      const fuente = readFileSync(fichero, "utf8");
      expect(
        fuente,
        `${fichero} ya no construye un enlace \`${ruta}${marca}\`: o cambió la ruta ` +
          "y hay que actualizarla aquí, o el enlace se movió a otro fichero.",
      ).toContain(`${ruta}${marca}`);
    }
  });

  it("finds every one of those paths declared in the frontend's route table", () => {
    if (!existsSync(APP_TSX)) {
      // `web` is not beside `api` here. Nothing to compare against.
      return;
    }
    const app = readFileSync(APP_TSX, "utf8");
    const declaradas = new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]));

    const faltan: string[] = [];
    for (const { ruta } of ENLACES) {
      // react-router nests: `/app/perfil` is `path="/app"` with a child
      // `path="perfil"`. Checking each segment is declared somewhere is
      // looser than resolving the tree, and it is exactly enough to catch
      // the failure this test exists for — a segment that appears nowhere.
      const segmentos = ruta.split("/").filter(Boolean);
      for (let i = 0; i < segmentos.length; i++) {
        const s = segmentos[i];
        if (!declaradas.has(s) && !declaradas.has(`/${s}`)) {
          faltan.push(`${ruta} → el segmento "${s}" no está declarado en App.tsx`);
        }
      }
    }

    expect(
      faltan,
      "Un correo va a mandar a alguien a una página que no existe. En App.tsx eso no " +
        "da un 404: cae en el comodín `<Route path=\"*\">`, `Navigate` se lleva el " +
        "fragmento por delante con el token dentro, y la persona acaba en la pantalla " +
        "de inicio sin que nada falle a la vista.",
    ).toEqual([]);
  });

  it("confirms the catch-all that makes a wrong path silent is still there", () => {
    if (!existsSync(APP_TSX)) return;
    const app = readFileSync(APP_TSX, "utf8");
    // Not a complaint about the catch-all — it is the right thing for a SPA.
    // It is *why* the test above has to exist: with a 404 instead, the broken
    // link would have announced itself the first time anybody clicked one.
    expect(app).toMatch(/path="\*"/);
  });
});
