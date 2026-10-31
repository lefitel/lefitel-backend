# Encargado de tramo — design

Date: 2026-10-31. Requested by the client through Isaias.

## 1. What is asked

A tramo has one person in charge (`encargado`), a user. A user can be in charge of
many tramos. The general report shows it as one more column.

## 2. Decisions taken by Isaias (not to be reopened without him)

1. **One encargado, the current one.** No history table. A report of an old period
   shows whoever is in charge today. Who it was before lives only in the bitácora.
2. **Any active (non-archived) user** can be encargado. No role filter.
3. **Archiving a user who is in charge of tramos** warns, lists those tramos, and
   forces clearing them: the only way forward is "Quitar de N tramos y archivar".
   The server enforces it too.
4. Extras in scope: tramos a su cargo in the user's ficha, an encargado filter in
   the general report, an `Encargado` field in the generator's Tramo root, and the
   encargado in the tramo list rows (map panel and Archivados).

## 3. Decisions of mine

- **New column `tramos.id_encargado`**, nullable FK to `usuarios.id`,
  `ON DELETE SET NULL` (users are soft-deleted, so the FK only matters for a hard
  delete by hand). It is NOT `tramos.id_usuario`: that one is "registrado por",
  authorship, shown behind `seguridad.ver`. Mixing them would leak authorship or
  hide the assignment.
- **The encargado is operational, not authorship:** it travels to anyone who can
  see the tramo or the report. `id_encargado` joins `TRAMO_PUBLIC_ATTRIBUTES`, and
  `INCLUDE_TRAMO` includes the user as `encargado` with `USUARIO_AS_AUTHOR` only
  and **paranoid** (changed during the build: `responseShape.test.ts` forbids any
  user column beyond those three, `deletedAt` included).
- **Presented shape:** `TramoPresentado.encargado: { id, nombre } | null`. An
  archived account (only a hand edit can leave one, given decision 3) arrives as
  `id_encargado` set and `encargado: null`; the tramo card says "Usuario
  archivado (#id)", the report and its filter read it as no encargado.
- **Who assigns:** `PUT /tramos/:id` with `id_encargado: number | null`, under the
  existing `tramos.editar`. The id must be an active user, else 400.
- **Where the picker gets its names:** `GET /usuarios` needs `seguridad.ver`, which
  a tramo editor usually lacks. `GET /tramos/options` adds
  `usuarios: [{ id, nombre }]` (active only) when the caller has `tramos.editar`;
  otherwise the key is absent.
- **Bitácora:** `UPDATE_TRAMO` metadata gains `encargado` (name) and `id_encargado`
  in `before`/`after`.
- **Archive flow:** `GET /usuario/:id/tramos` (`requireSelfOrPermission("seguridad",
  "ver")`, a list envelope; archived tramos included and marked) feeds both the
  ficha and the dialog. `DELETE /usuario/:id` answers 409 with the current list
  unless `?liberarTramos=14,15` names exactly the tramos the person carries; then
  those ids are cleared inside the archive's existing transaction, and one
  `UPDATE_TRAMO` per tramo is logged. A role with `seguridad.archivar` but not
  `seguridad.ver` gets no list up front and learns it from the 409. Un-archiving
  does not give the tramos back.
- **Race between assigning and archiving:** the archive locks the user's row FOR
  UPDATE before looking; `updateTramo` checks a new encargado under FOR SHARE on
  the same row, inside the transaction that writes. One waits for the other.
- **Filter in the general report:** client-side, like estado/prioridad/criticidad,
  over `poste.tramo.encargado.id`, with a "Sin encargado" option. No API parameter.
- **Generator:** `tramo.encargado` string field, the live account's name built as
  `nombreDeUsuario` builds it (parts trimmed, empty ones skipped), grouped by the
  account id; not behind the security permission, unlike "Registrado por".
- **Exports:** the column goes after `Tramo` in screen, Excel, CSV and PDF. The PDF
  already had 18 columns; widths are now one per header by name (260 of 277 mm),
  held by a test. A real export has not been opened yet.

## 4. Out of scope

History of encargados; filtering other reports by encargado; notifying the
encargado of new incidents.

## 5. Verification

`npm run typecheck` and `npm test` in both repos; migration up/down on
`osefi_local`; one exported Excel, CSV and PDF opened and read; the archive dialog
exercised with a user who has tramos.
