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

/** The declared ceiling in `files.routes.ts`, written out so a change to it fails here. */
const LIMITE_BYTES = 10 * 1024 * 1024;

/** A plain image of the given size, as `format`, optionally with an EXIF orientation. */
const foto = (width: number, height: number, orientation?: number) => {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg();
  return (orientation ? base.withMetadata({ orientation }) : base).toBuffer();
};

/** Uploads `buffer` and returns the stored file's metadata. */
async function subir(buffer: Buffer) {
  const res = await request(app)
    .post("/api/files")
    .set("Cookie", COOKIE)
    .set(DEL_FRONTEND)
    .attach("file", buffer, "foto.jpg");
  expect(res.status).toBe(201);
  return sharp(path.join(directory, res.body.path.slice(1))).metadata();
}

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
  // `pass_changed_at` a year back, older than any session these tests build.
  // `authenticate` refuses a session opened before it, and without the column
  // the rule compares against `NaN` and passes everything — which is how a
  // mutation test found this whole surface covering nothing.
  usuarioFindByPk.mockResolvedValue({
    dataValues: { id: YO, id_rol: MI_ROL, user: "isaias", name: "Isaias", lastname: "Salas", image: null, pass_changed_at: new Date(Date.now() - 365 * 86_400_000) },
  } as never);
});

/** The files sitting in the redirected images directory right now. */
const stored = () => fs.readdir(directory);

describe("POST /api/files with a real multipart body", () => {
  it("parses the file, converts it and writes it inside the images directory", async () => {
    const res = await request(app)
      .post("/api/files")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("file", imagen, "Foto del Poste 42.png");

    expect(res.status).toBe(201);

    // The name is ours, not theirs: spaces to underscores, extension replaced.
    expect(res.body.path).toMatch(/^\/\d+_Foto_del_Poste_42\.webp$/);

    const [escrito] = await stored();
    expect(escrito).toBe(res.body.path.slice(1));

    // webp, and still 2400x1200 — proof the whole chain ran, not just that a
    // file appeared. The controller caps the longest side at 2560 with
    // `withoutEnlargement`, and this source is smaller than that, so the
    // pixels are meant to survive untouched.
    const meta = await sharp(path.join(directory, escrito)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.height).toBe(1200);
    expect(meta.width).toBe(2400);
  });

  it("refuses a file over the declared limit and writes nothing", async () => {
    const grande = Buffer.alloc(LIMITE_BYTES + 1024);

    const res = await request(app)
      .post("/api/files")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("file", grande, "enorme.png");

    // 413 and not 500: the caller sent something too big, which is a fact only
    // they can act on. The message names the ceiling for the same reason — the
    // alternative is retrying the same photograph, since nothing in a generic
    // failure suggests a smaller one would work.
    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/10 MB/);
    // And the part that matters most: nothing on disk. multer's limit has to
    // stop the body before the controller ever sees a `req.file`.
    expect(await stored()).toEqual([]);
  });

  // Field photographs are zoomed into to read a plate or see a crack. Until May
  // 2026 they were cut to 1000 px tall at JPEG 60, and that is what made three
  // in four of them blurry; after it, to 1920 px *tall* only, so a landscape
  // shot kept its width but a portrait lost a third of its detail.
  it("caps the longest side at 2560, whichever way the photograph is held", async () => {
    const apaisada = await subir(await foto(4000, 3000));
    expect([apaisada.width, apaisada.height]).toEqual([2560, 1920]);

    const vertical = await subir(await foto(3000, 4000));
    expect([vertical.width, vertical.height]).toEqual([1920, 2560]);
  });

  it("accepts a photograph between the old ceiling and the new one", async () => {
    // A phone photo of 6-9 MB used to be refused or squeezed twice; the browser
    // now sends anything up to 8 MB untouched, so the server has to take it.
    const pesada = Buffer.concat([await foto(800, 600), Buffer.alloc(6 * 1024 * 1024)]);
    const meta = await subir(pesada);
    expect(meta.format).toBe("webp");
  });

  it("turns the pixels the way the phone said, instead of losing the instruction", async () => {
    // A phone stores many photos sideways with an EXIF note saying «rotate
    // 90°». Converting to webp drops the note, so without applying it first the
    // stored photo lies on its side. Measured on 14 October 2026: it did.
    const meta = await subir(await foto(400, 200, 6));
    expect([meta.width, meta.height]).toEqual([200, 400]);
  });

  it("refuses a file sent under a field name the route does not declare", async () => {
    const res = await request(app)
      .post("/api/files")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("imagen", imagen, "otro-campo.png");

    expect(res.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("answers a multipart body carrying no file at all, without crashing", async () => {
    const res = await request(app)
      .post("/api/files")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .field("nada", "nada");

    // 400, not the 500 this used to answer. Sending no file is something the
    // caller did, and a 500 is what somebody gets paged about.
    expect(res.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("refuses a file that is not an image, without blaming the server", async () => {
    const res = await request(app)
      .post("/api/files")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .attach("file", Buffer.from("esto es texto plano, no una imagen"), "mentira.png");

    // The extension says png and the bytes do not. sharp refuses it, and that
    // refusal is about the file we were handed — 400 — not about this server
    // failing, which is what it used to answer.
    expect(res.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("is behind the session cookie like every other write", async () => {
    const res = await request(app)
      .post("/api/files")
      .set(DEL_FRONTEND)
      .attach("file", imagen, "sin-sesion.png");

    expect(res.status).toBe(401);
    expect(await stored()).toEqual([]);
  });
});
