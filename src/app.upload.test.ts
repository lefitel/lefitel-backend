// The upload endpoint through real multer, with a real multipart body.
//
// `upload.controller.test.ts` is a strong test of the *name*: it feeds `safeName`
// and `resolveImagePath` every hostile shape and checks nothing lands outside
// the images directory. What it never does is send a request. It calls two pure
// functions, so multer — the middleware that parses the multipart body and
// produces the `req.file` the controller reads — is not covered by a single
// assertion anywhere in this repository.
//
// That gap surfaced when multer went from 1.4.5-lts.2 to 2.2.0. The 1.x line is
// deprecated for vulnerabilities patched in 2.x, so the bump is not optional,
// and the whole suite stayed green through it — which proved nothing, because
// nothing was looking. This file is what makes the next bump verifiable: it goes
// in through `supertest` with a genuine multipart body, so the parser, the size
// limit and the field name are all exercised by the code that runs in
// production.
//
// `IMAGES_DIR` is redirected to a temporary directory before `app.js` is
// imported. `upload.controller.ts` reads the variable once, at module load, and
// `dotenv.config()` does not overwrite a value already set — so the order here
// is load-bearing: set it first, import second, or the test writes into
// `C:/images` for real.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osefi-upload-"));
process.env.IMAGES_DIR = directory;

vi.mock("./permissions/store.js", () => ({
  permissionsFor: async () => ({}),
  can: async () => false,
  invalidatePermissions: vi.fn(),
}));
vi.mock("./utils/logAction.js", () => ({ logAction: vi.fn() }));

const app = (await import("./app.js")).default;
const { SESSION_COOKIE_NAME } = await import("./auth/sessionCookie.js");
const { CSRF_CLIENT_HEADER, allowedOrigins } = await import("./config/security.js");
const { UsuarioModel } = await import("./models/usuario.model.js");
const { SesionModel } = await import("./models/sesion.model.js");

const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");

const YO = 7;
const MI_ROL = 2;
const COOKIE = `${SESSION_COOKIE_NAME}=un-token-opaco-de-treinta-y-dos-bytes`;
/** What a browser sends alongside the cookie; `requireSameOrigin` refuses a write without it. */
const DEL_FRONTEND = {
  Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0] as string,
  [CSRF_CLIENT_HEADER]: "web",
};

/** The declared ceiling in `upload.routes.ts`, written out so a change to it fails here. */
const LIMITE_BYTES = 5 * 1024 * 1024;

let imagen: Buffer;

beforeAll(async () => {
  // A real PNG, because the point is exercising the parser and sharp, not a stub.
  imagen = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: { r: 30, g: 90, b: 140 } },
  })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Emptied rather than recreated: the path is baked into `upload.controller.ts`
  // at import time, so it has to stay the same directory for the whole file.
  for (const leftover of await fs.readdir(directory)) {
    await fs.rm(path.join(directory, leftover), { force: true });
  }
  sesionFindOne.mockResolvedValue({
    dataValues: {
      id: "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa",
      id_usuario: YO,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
      last_used_at: new Date(),
      estado: "completa",
      mfa_satisfied_at: null,
    },
  } as never);
  sesionUpdate.mockResolvedValue([1] as never);
  usuarioFindByPk.mockResolvedValue({
    dataValues: { id: YO, id_rol: MI_ROL, user: "isaias", name: "Isaias", lastname: "Salas", image: null },
  } as never);
});

/** The files sitting in the redirected images directory right now. */
const stored = () => fs.readdir(directory);

describe("POST /api/upload with a real multipart body", () => {
  it("parses the file, converts it and writes it inside the images directory", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("file", imagen, "Foto del Poste 42.png");

    expect(res.status).toBe(200);

    // The name is ours, not theirs: spaces to underscores, extension replaced.
    expect(res.body.path).toMatch(/^\/\d+_Foto_del_Poste_42\.webp$/);

    const [escrito] = await stored();
    expect(escrito).toBe(res.body.path.slice(1));

    // webp, and still 1200 tall — proof the whole chain ran, not just that a
    // file appeared. The controller resizes to a height of 1920 with
    // `withoutEnlargement`, and this source is shorter than that, so the
    // pixels are meant to survive untouched.
    const meta = await sharp(path.join(directory, escrito)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.height).toBe(1200);
    expect(meta.width).toBe(2400);
  });

  it("refuses a file over the declared limit and writes nothing", async () => {
    const grande = Buffer.alloc(LIMITE_BYTES + 1024);

    const res = await request(app)
      .post("/api/upload")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("file", grande, "enorme.png");

    // Not a 2xx, and — the part that matters — nothing on disk. multer's limit
    // has to stop the body before the controller ever sees a `req.file`.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stored()).toEqual([]);
  });

  it("refuses a file sent under a field name the route does not declare", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("imagen", imagen, "otro-campo.png");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stored()).toEqual([]);
  });

  it("answers a multipart body carrying no file at all, without crashing", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .field("nada", "nada");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stored()).toEqual([]);
  });

  it("is behind the session cookie like every other write", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set(DEL_FRONTEND)
      .attach("file", imagen, "sin-sesion.png");

    expect(res.status).toBe(401);
    expect(await stored()).toEqual([]);
  });
});
