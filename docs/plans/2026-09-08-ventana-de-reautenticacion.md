# Ventana de reautenticación — plan de implementación

> ⚠️ **Nota del 2026-10-10.** Los pasajes de este documento sobre `sinVentana` y `exigeContrasena` describen lo que se decidió y se construyó entonces. Esa opción y ese campo del 403 ya no existen: toda ruta con puerta de step-up entra en la ventana de diez minutos (decisión de Isaias, ver «Revisión 4» en `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md`). El texto de abajo se conserva como historia, no como descripción del código actual.

> **Para agentes:** SUB-SKILL OBLIGATORIA: usa `superpowers:subagent-driven-development`
> (recomendado) o `superpowers:executing-plans` para ejecutar tarea a tarea. Los pasos usan
> casillas (`- [ ]`) para seguimiento.

**Objetivo:** que confirmar la identidad una vez abra diez minutos durante los cuales las
operaciones administrativas ordinarias no vuelvan a pedir nada, y que la contraseña deje de
pedirse dos veces para una sola operación.

**Arquitectura:** no se añaden modos a la puerta. `requireStepUp` conserva su forma; su
opción `exigeContrasena` se renombra a `sinVentana` —que es lo que de verdad hace una vez
borrada la rama del pase libre— y se apaga en 8 de 23 rutas. La contraseña gana capacidad de
sellar en una columna propia de `sesiones`, consultada **solo** cuando la cuenta no tiene
ningún factor. El bucle del plazo de gracia se cierra borrando la función que borraba la
fecha, no añadiendo una columna que la recuerde.

**Stack:** `api/` Express 5 + TypeScript + Sequelize + Postgres + Vitest. `web/` React 19 +
Vite + Vitest + Testing Library.

**Spec:** [`api/docs/specs/2026-09-08-ventana-de-reautenticacion-design.md`](../specs/2026-09-08-ventana-de-reautenticacion-design.md)
— revisión 3. El plan argumenta desde la spec: se leen los dos.

## Restricciones globales

- **Rama:** `isaias` en los dos repos. Nunca `main` ni `development`.
- **Un solo commit al terminar el arco entero.** Los `git commit` de cada tarea son para el
  ejecutor si trabaja en un worktree aislado; si se trabaja sobre el árbol de Isaias, **se
  acumula y se commitea una vez al final**, añadiendo ficheros por nombre y nunca `git add -A`.
- **Mensajes de commit en inglés.** Código, comentarios y nombres de símbolo en inglés.
- 🔴 **`tsconfig.json` tiene `"strict": false`.** Olvidar una pieza de la cadena de la columna
  nueva **compila limpio y falla en silencio**. La Tarea 5 existe para eso.
- 🔴 **El nombre de la opción cambia; el nombre del campo del cable NO.** La opción de
  `requireStepUp` pasa a llamarse `sinVentana`. El campo que viaja en el cuerpo del 403 sigue
  llamándose **`exigeContrasena`**, porque `web/src/api/stepUp.ts:71` ya lo lee y los dos
  repos se despliegan por separado. Confundirlos rompe producción en silencio.
- **Ningún test se ajusta para que pase.** Si un test se pone rojo, o el cambio está mal, o
  el test protegía algo que hay que sustituir por otro testigo. La Tarea 14 lo recoge.
- **Verificación:** `cd api && npm run typecheck && npm run lint && npm test`;
  `cd web && npm run lint && npm run test`.

---

## Estructura de ficheros

**`api/` — se crea:**
| Fichero | Responsabilidad |
|---|---|
| `src/migrations/20260908000001-add-password-confirmed-at.ts` | La columna `sesiones.password_confirmed_at` |
| `src/migrations/20260908000001-add-password-confirmed-at.test.ts` | Que el `up`/`down` sean idempotentes y transaccionales |
| `src/controllers/usuarioRol.controller.ts` | `asignarRol`: el único sitio que escribe `id_rol` de otra cuenta |
| `src/controllers/usuarioRol.controller.test.ts` | Sus reglas: permiso, no-a-uno-mismo, rol existente |

**`api/` — se modifica:**
| Fichero | Qué cambia |
|---|---|
| `src/middleware/requireStepUp.ts` | Renombrado de la opción, borrado de la rama del pase libre, lectura de la columna nueva, el `motivo` sin `metodos`, el campo `exigeContrasena` en el `denegar` |
| `src/middleware/loginLimiters.ts` | El cupo pasa a cobrar antes de comparar (Tarea 1) |
| `src/auth/sessionPromotion.ts` | Nace `sellarContrasena`; muere `apagarLaMecha` |
| `src/auth/sessionStore.ts` | `findLiveSession` proyecta y mapea la columna |
| `src/middleware/authenticate.ts` | Monta la columna en `req.user` |
| `src/models/sesion.model.ts`, `src/interfaces/index.ts`, `src/app.ts` | El atributo, `ISesion`, el tipo global |
| `src/routes/usuario.routes.ts`, `rol.routes.ts`, `permiso.routes.ts`, `auth.routes.ts`, `totp.routes.ts`, `webauthn.routes.ts`, `recoveryCodes.routes.ts` | `sinVentana` por fila, según la tabla de la spec §4.1 |
| `src/controllers/usuario.controller.ts` | `id_rol` fuera de la allowlist; `updateUserName` sin `oldPass`; `issueSession` pasa por `estadoInicialDeSesion` |
| `src/controllers/email.controller.ts`, `totp.controller.ts`, `webauthn.controller.ts` | Fuera las tres llamadas a `apagarLaMecha` |
| `src/utils/logger.ts` | `stepup_password` en `REDACT_PATHS` |
| `src/routes/routeGuards.test.ts` | `STEP_UP_OPTIONS` con las tres opciones por fila |

**`web/` — se crea:**
| Fichero | Responsabilidad |
|---|---|
| `src/components/dialogs/useStepUpCeremony.ts` | El estado y las acciones del diálogo |
| `src/components/dialogs/useStepUpCeremony.test.ts` | Sus transiciones, sin DOM |

**`web/` — se modifica:** `src/api/Login.api.ts`, `src/api/stepUpInterceptor.ts`,
`src/components/dialogs/StepUpDialog.tsx`, `src/pages/menu/perfil/PerfilAcceso.tsx`,
`src/pages/menu/perfil/PerfilPage.tsx`, `src/pages/menu/usuario/UsuarioDetallePage.tsx`,
`src/api/Usuario.api.ts`.

---

## Orden y por qué

Las tareas 1→7 van en ese orden y no es intercambiable:

- **1 antes que todo**: la spec §12 la declara prerrequisito. Sin ella, la ventana convierte
  adivinar la contraseña en «comprar diez minutos» en vez de «comprar una operación».
- **2 antes que 3-6**: el renombrado es mecánico y toca los mismos ficheros. Hacerlo después
  significa reescribir lo que las otras tareas acaban de escribir.
- **5 antes que 6**: apagar `sinVentana` sin que la columna funcione deja las 8 rutas pidiendo
  la contraseña igual (falla cerrado, pero el arco no entrega nada).
- **7 después de 5**: cerrar el rodeo de la rotación de sesión necesita que `estadoEfectivo`
  ya no dependa de nada nuevo.

---

# Tarea 1 — El cupo de contraseñas, atómico

**Por qué.** `security.ts:66-68` declara que este cubo *«es lo único que está entre una sesión
robada y un oráculo de contraseñas ilimitado»*. Hoy la puerta **lee** el contador
(`requireStepUp.ts:584`), tarda ~250 ms comparando (`:601`) y **cobra después** (`:628`): N
peticiones simultáneas leen todas cero y pasan todas. Prerrequisito de la ventana.

**Ficheros:**
- Modificar: `api/src/middleware/requireStepUp.ts:583-628`
- Modificar: `api/src/middleware/loginLimiters.ts` (exportar el consumo atómico)
- Test: `api/src/middleware/requireStepUp.test.ts`

**Interfaces:**
- Produce: `consumirCupoDeConfirmacion(idUsuario: number): Promise<{ permitido: boolean; restantes: number }>`
  en `loginLimiters.ts`, y `devolverCupoDeConfirmacion(idUsuario: number): Promise<void>`.

- [ ] **Paso 1: escribir el test que falla**

En `api/src/middleware/requireStepUp.test.ts`, dentro del `describe` del presupuesto:

```ts
it("no deja pasar más de PASSWORD_CONFIRM_LIMIT comparaciones lanzadas a la vez", async () => {
  // Diez peticiones que entran en el mismo tick, todas con la contraseña mal.
  // La lectura-luego-cobro dejaba pasar las diez a bcrypt; el consumo atómico
  // solo debe dejar pasar PASSWORD_CONFIRM_LIMIT.
  verifyOwnPassword.mockResolvedValue({ ok: false });
  const gate = requireStepUp({ sinVentana: true });

  const intentos = Array.from({ length: 10 }, () =>
    correrPuerta(gate, { user: usuarioSinFactor, body: { stepup_password: "mal" } }),
  );
  await Promise.all(intentos);

  expect(verifyOwnPassword).toHaveBeenCalledTimes(PASSWORD_CONFIRM_LIMIT);
});
```

- [ ] **Paso 2: verlo fallar, y por el motivo correcto**

Run: `cd api && npx vitest run src/middleware/requireStepUp.test.ts -t "lanzadas a la vez"`
Esperado: FAIL con `expected 10 to be 5`. **Si falla con otro mensaje, el test está mal
montado, no el código.**

- [ ] **Paso 3: el consumo atómico en `loginLimiters.ts`**

```ts
/**
 * Consume un intento del cubo de confirmación y dice si quedaba.
 *
 * 🔴 **Cobra ANTES de comparar, no después.** La versión anterior leía el
 * contador con `getKey`, tardaba ~250 ms en un `bcrypt` y cobraba al final:
 * N peticiones en el mismo tick leían todas cero y pasaban todas, así que el
 * tope de cinco por cuarto de hora era en realidad ~200. Medido en la
 * auditoría del 2026-09-08.
 *
 * El acierto se devuelve con `devolverCupoDeConfirmacion`, que es lo que
 * mantiene la promesa de `security.ts`: «las correctas no cuestan nada».
 */
export async function consumirCupoDeConfirmacion(
  idUsuario: number,
): Promise<{ permitido: boolean; restantes: number }> {
  const store = passwordConfirmLimiter.store;
  const { totalHits } = await store.increment(passwordConfirmKey(idUsuario));
  const restantes = Math.max(0, PASSWORD_CONFIRM_LIMIT - totalHits);
  return { permitido: totalHits <= PASSWORD_CONFIRM_LIMIT, restantes };
}

export async function devolverCupoDeConfirmacion(idUsuario: number): Promise<void> {
  await passwordConfirmLimiter.store.decrement(passwordConfirmKey(idUsuario));
}
```

- [ ] **Paso 4: usarlo en la puerta**

En `requireStepUp.ts`, sustituir el bloque `getKey` → comparar → `cobrar` por:

```ts
const cupo = await consumirCupoDeConfirmacion(user.id);
if (!cupo.permitido) {
  await devolverCupoDeConfirmacion(user.id); // no cuenta el que ni se comparó
  responderCupoAgotado(req, res);
  return;
}
const confirmacion = await verifyOwnPassword(user.id, password, req);
if (confirmacion.ok) {
  await devolverCupoDeConfirmacion(user.id); // las correctas no cuestan nada
} else {
  denegar(req, res, MENSAJE_CONTRASENA_INCORRECTA, MOTIVO_CONTRASENA_INCORRECTA, {
    intentosRestantes: cupo.restantes,
  });
  return;
}
```

- [ ] **Paso 5: verlo pasar, y no romper los vecinos**

Run: `cd api && npx vitest run src/middleware/requireStepUp.test.ts src/app.auth.test.ts`
Esperado: PASS. `app.auth.test.ts:1743` hace aritmética sobre este cubo — si se pone rojo,
**leer su comentario antes de tocarlo**: dice qué propiedad fija.

- [ ] **Paso 6: commit**

```bash
git add src/middleware/requireStepUp.ts src/middleware/loginLimiters.ts src/middleware/requireStepUp.test.ts
git commit -m "fix(auth): charge the confirm budget before comparing, not after"
```

---

# Tarea 2 — Renombrar `exigeContrasena` → `sinVentana`

**Por qué.** Una vez borrada la rama del pase libre (Tarea 3), la contraseña la exige la
puerta **siempre**; lo único que esa opción hace es apagar el atajo de la ventana. Su
docstring de quince líneas (`requireStepUp.ts:180-195`) diría lo contrario en el fichero más
citado del arco.

🔴 **Solo la opción.** El campo del cable sigue siendo `exigeContrasena`.

**Ficheros:** `api/src/middleware/requireStepUp.ts`, los siete `*.routes.ts`,
`api/src/routes/routeGuards.test.ts`, `api/src/middleware/requireStepUp.test.ts`,
`api/src/routes/{totp,recoveryCodes,usuario}.routes.test.ts`.

- [ ] **Paso 1: inventariar antes de tocar**

```bash
cd api && grep -rn "exigeContrasena" src --include=*.ts | wc -l && grep -rln "exigeContrasena" src --include=*.ts
```
Anotar el número. Al final tiene que quedar **solo** en los sitios del cable (`denegar`, el
tipo del rechazo) y en cero sitios como nombre de opción.

- [ ] **Paso 2: renombrar la opción y reescribir su docstring**

En `requireStepUp.ts`, en la interfaz de opciones:

```ts
  /**
   * Esta ruta pide la contraseña en **cada** petición.
   *
   * Se llamaba `exigeContrasena`. El nombre va a dejar de describir lo que
   * hace: cuando la rama que deja pasar a las cuentas sin factor desaparezca,
   * la contraseña la exigirá la puerta siempre y lo único que quedará de esta
   * opción será apagar el atajo de la ventana de diez minutos.
   *
   * La lista canónica de qué rutas la llevan es `STEP_UP_OPTIONS` en
   * `routes/routeGuards.test.ts`, que compara la tabla contra los montajes
   * reales en las dos direcciones. Ver también la spec §4.1.
   *
   * 🔴 **El campo del cable NO se renombra.** El 403 sigue llevando
   * `exigeContrasena`, porque `web/src/api/stepUp.ts:71` ya lo lee y los dos
   * repos se despliegan aparte.
   */
  sinVentana?: boolean;

🔴 **Dos reglas para todo comentario que escribas en este arco**, y salen de un
defecto real de la revisión de esta misma tarea:

- **Describe lo que el código hace HOY, nunca lo que hará una tarea posterior.**
  Un docstring que dice «la rama ya no existe» mientras la rama sigue viva es
  un comentario que promete seguridad inexistente — la clase de defecto del que
  una auditoría del 2026-09-08 encontró once en este repositorio.
- **No pongas recuentos.** «Las 15 rutas», «doce de las catorce monturas»: un
  número en un comentario que tiene que coincidir con una tabla de otro fichero
  se desincroniza solo. Señala la tabla y que se mire ahí.
```

- [ ] **Paso 3: propagar el nombre**

```bash
cd api && grep -rl "exigeContrasena:" src --include=*.ts | xargs sed -i 's/exigeContrasena:\s*true/sinVentana: true/g; s/exigeContrasena:\s*false/sinVentana: false/g'
```
Y a mano: la desestructuración de las opciones en `requireStepUp.ts`, la comprobación de
montaje de `:282-287` (`toleraFactorIlegible && !sinVentana`), el helper
`conContrasena()` de `rol.routes.ts:43` → renombrar a `sinVentana()`, y la constante
`CONTRASENA_Y_ONBOARDING` de `routeGuards.test.ts`.

⚠️ **Revisar el diff del `sed`**: no debe haber tocado el `denegar` ni el tipo del rechazo.

- [ ] **Paso 4: verificar**

Run: `cd api && npm run typecheck && npx vitest run src/routes src/middleware`
Esperado: PASS, sin cambios de comportamiento. `grep -rn "exigeContrasena" src` debe salir
solo en el `denegar` y en el tipo.

- [ ] **Paso 5: commit**

```bash
git add src/middleware/requireStepUp.ts src/routes src/middleware/requireStepUp.test.ts
git commit -m "refactor(auth): rename exigeContrasena to sinVentana, which is what it does"
```

---

# Tarea 3 — Borrar la rama del pase libre y arreglar el `motivo`

**Por qué.** Esa rama deja pasar sin ninguna prueba a las cuentas sin factor, que hoy son
todas. Su única justificación escrita —que ningún cliente sabía enviar la contraseña— caducó
con el plan 4D. Tres auditores encontraron por separado el agujero que deja:
`DELETE /auth/sessions/:id` alcanzable con la cookie sola.

**Ficheros:**
- Modificar: `api/src/middleware/requireStepUp.ts:34-56`, `:476-561`
- Test: `api/src/middleware/requireStepUp.test.ts`, `api/src/app.auth.test.ts:1087`

- [ ] **Paso 1: el test que falla**

```ts
it("deniega a una cuenta sin factor que no manda contraseña, en cualquier ruta con puerta", async () => {
  // La rama del pase libre dejaba pasar esto con una línea STEP_UP_SKIPPED.
  // Ahora no hay nada que pasar: la contraseña es el método de esa cuenta.
  tieneAlgunFactor.mockResolvedValue(false);
  const res = await correrPuerta(requireStepUp(), { user: usuarioSinFactor, body: {} });

  expect(res.status).toBe(403);
  expect(res.body.code).toBe(CODIGO_STEP_UP);
  expect(res.body.motivo).toBe(MOTIVO_CONTRASENA_REQUERIDA);
  // 🔴 Sin `metodos`: `describeMetodos(["password"])` gana al `??` del diálogo
  // y enseñaría «esta versión no conoce ese método» sobre un campo de contraseña.
  expect(res.body).not.toHaveProperty("metodos");
  // El par (motivo, exigeContrasena) es el discriminante de la ceremonia del cliente.
  expect(res.body.exigeContrasena).toBe(false);
});
```

- [ ] **Paso 2: verlo fallar**

Run: `cd api && npx vitest run src/middleware/requireStepUp.test.ts -t "sin factor que no manda"`
Esperado: FAIL con `expected 200 to be 403`.

- [ ] **Paso 3: borrar la rama y ajustar el `denegar`**

Sustituir el bloque `:476-561` (el docstring del pase libre, el `logAction` de
`STEP_UP_SKIPPED` y su `next()`) por:

```ts
      const password = (req.body as Record<string, unknown> | undefined)?.[STEP_UP_PASSWORD_FIELD];
      if (typeof password !== "string" || password === "") {
        // Refusada gratis: no se comparó nada, así que no hay nada que cobrar.
        // Cobrar aquí dejaría que un cliente que olvide el campo quemase el
        // cupo de otra persona y la encerrase fuera de la pantalla que lo arregla.
        //
        // 🔴 **Sin `metodos`.** Este motivo describe una cuenta que no tiene
        // ningún factor, así que su único método es la contraseña — y
        // `describeMetodos(["password"])` en el cliente devuelve «esta versión
        // no conoce ese método», que gana al `??` de `StepUpDialog.tsx:402` y
        // se enseñaría sobre el campo de contraseña. Medido el 2026-09-08.
        // Ausente, `describeMetodos(undefined)` devuelve `null` y sale la frase
        // correcta. El diálogo ya sabe pintar este caso.
        denegar(req, res, MENSAJE_CONTRASENA_REQUERIDA, MOTIVO_CONTRASENA_REQUERIDA, {
          // El par (motivo, exigeContrasena) es lo que el interceptor compara
          // para saber si una petición encolada puede reusar la ceremonia viva.
          // Sin este campo, dos rutas de modos distintos contestan el mismo par.
          exigeContrasena: Boolean(sinVentana),
        });
        soltarContrasena(req);
        return;
      }
```

- [ ] **Paso 4: verlo pasar y corregir el test que certificaba el agujero**

`app.auth.test.ts:1087` espera hoy un 200 con la sesión ajena borrada, **y pasa en verde**.
Cambia a 403. Su aserción IDOR (`updateWhere()` con `id_usuario: YO`) se pierde: hay que
sustituirla por un test con el sello fresco, que es el único escenario en el que esa consulta
se llega a ejecutar ahora.

Run: `cd api && npx vitest run src/middleware/requireStepUp.test.ts src/app.auth.test.ts`

- [ ] **Paso 5: commit**

```bash
git add src/middleware/requireStepUp.ts src/middleware/requireStepUp.test.ts src/app.auth.test.ts
git commit -m "fix(auth): remove the branch that waved factor-less accounts through"
```

---

# Tarea 4 — La migración de `password_confirmed_at`

**Ficheros:**
- Crear: `api/src/migrations/20260908000001-add-password-confirmed-at.ts` y su `.test.ts`

**Interfaces:**
- Produce: la columna `sesiones.password_confirmed_at TIMESTAMPTZ NULL`.

- [ ] **Paso 1: el test primero** — copiar la forma de
  `20260826000002-add-mfa-columns.test.ts`: que `up` sea idempotente, que `down` corra en
  transacción con `SET LOCAL lock_timeout = '5s'`, y que la columna nazca nullable sin default.

- [ ] **Paso 2: verlo fallar**

Run: `cd api && npx vitest run src/migrations/20260908000001-add-password-confirmed-at.test.ts`
Esperado: FAIL, el módulo no existe.

- [ ] **Paso 3: la migración**

```ts
/**
 * `sesiones.password_confirmed_at` — cuándo esta sesión confirmó su contraseña.
 *
 * **No es `mfa_satisfied_at` y no puede serlo.** Esa columna significa «esta
 * sesión probó un FACTOR», y `estadoEfectivo` (`auth/sessionState.ts:428`) la
 * lee para decidir que una cuenta con factor no tiene nada que configurar. Si
 * una confirmación de contraseña la escribiera, una cuenta sin factor que
 * teclease su contraseña una vez se quedaría `completa` pasado el plazo de
 * catorce días. Cuatro auditores encontraron eso por separado el 2026-09-08.
 *
 * **NULL, sin default y sin relleno**, a propósito: para toda sesión que ya
 * existe, «no ha confirmado» es la respuesta correcta.
 *
 * **Nadie la pone a NULL.** Los seis sitios que invalidan una sesión llaman a
 * `revokeAllSessionsOf`, y `findLiveSession` (`auth/sessionStore.ts:155-161`)
 * excluye `revoked_at IS NOT NULL`: la columna muere con la fila. Se lee
 * únicamente a través de esa función.
 */
export async function up({ context: qi }: { context: QueryInterface }): Promise<void> {
  const t = await qi.sequelize.transaction();
  try {
    await qi.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction: t });
    const tabla = await qi.describeTable("sesiones");
    if (!tabla.password_confirmed_at) {
      await qi.addColumn(
        "sesiones",
        "password_confirmed_at",
        { type: DataTypes.DATE, allowNull: true },
        { transaction: t },
      );
    }
    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

export async function down({ context: qi }: { context: QueryInterface }): Promise<void> {
  const t = await qi.sequelize.transaction();
  try {
    await qi.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction: t });
    // Sin guarda de datos: la columna es nueva y nada depende de ella. Perder
    // los sellos solo obliga a confirmar otra vez, que es el estado inicial.
    await qi.removeColumn("sesiones", "password_confirmed_at", { transaction: t });
    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }
}
```

- [ ] **Paso 4: verlo pasar** — `cd api && npx vitest run src/migrations/`

- [ ] **Paso 5: commit**

```bash
git add src/migrations/20260908000001-add-password-confirmed-at.ts src/migrations/20260908000001-add-password-confirmed-at.test.ts
git commit -m "feat(auth): add sesiones.password_confirmed_at"
```

---

# Tarea 5 — La cadena de seis piezas, y el sellado

🔴 **La tarea con más riesgo del plan.** `"strict": false` hace que olvidar cualquiera de las
seis compile limpio: `password_confirmed_at` llegaría `undefined`, la ventana no se
satisfaría nunca, y se desplegaría **exactamente la molestia que este arco quita**, en verde.
Por eso el primer test es de aceptación y va por la app montada.

**Ficheros:**
- Modificar: `api/src/interfaces/index.ts` (`ISesion`), `api/src/models/sesion.model.ts`
  (`SesionCreation` + atributo), `api/src/auth/sessionStore.ts` (`findLiveSession`),
  `api/src/middleware/authenticate.ts` (`req.user`), `api/src/app.ts` (tipo global),
  `api/src/auth/sessionPromotion.ts` (`sellarContrasena`),
  `api/src/middleware/requireStepUp.ts` (lectura y escritura)
- Modificar: `api/src/models/factorModels.test.ts:150-155`

**Interfaces:**
- Produce: `sellarContrasena(id_sesion: string): Promise<boolean>` en `sessionPromotion.ts`.

- [ ] **Paso 1: el test de aceptación, por la app montada**

```ts
it("la segunda operación dentro de los diez minutos no vuelve a pedir la contraseña", async () => {
  // Lo único que la persona nota, y lo único que ve la cadena entera de seis
  // piezas. Un test unitario de la puerta pasaría con la cadena rota.
  const agente = request.agent(app);
  await login(agente, cuentaSinFactor);

  const primera = await agente
    .put("/api/usuario/username/7")
    .send({ user: "nuevo", stepup_password: CONTRASENA_BUENA });
  expect(primera.status).toBe(200);

  const segunda = await agente.put("/api/usuario/username/7").send({ user: "otro" });
  expect(segunda.status).toBe(200); // sin stepup_password
});

it("no re-sella dentro de la ventana: los diez minutos son fijos", async () => {
  // La promesa de Isaias es «10 minutos fijos, sin renovarse». Si cada
  // confirmación mueve la fecha, la ventana se renueva sola indefinidamente.
  const agente = request.agent(app);
  await login(agente, cuentaSinFactor);
  await agente.put("/api/usuario/username/7").send({ user: "a", stepup_password: CONTRASENA_BUENA });
  const primerSello = await selloDe(agente);

  vi.advanceTimersByTime(5 * 60_000);
  await agente.put("/api/usuario/username/7").send({ user: "b", stepup_password: CONTRASENA_BUENA });

  expect(await selloDe(agente)).toEqual(primerSello);
});
```

- [ ] **Paso 2: verlos fallar** — el primero con `403`, el segundo con fechas distintas.

- [ ] **Paso 3: las seis piezas, en este orden**

1. `interfaces/index.ts` — `password_confirmed_at: Date | null;` en `ISesion`.
2. `models/sesion.model.ts` — el atributo (`DataTypes.DATE`, `allowNull: true`) y la clave en
   `SesionCreation`.
3. `auth/sessionStore.ts` — la clave en el `attributes` de `findLiveSession`, en su tipo de
   retorno y en el mapeo.
4. `middleware/authenticate.ts` — la clave en el objeto que monta `req.user`.
5. `app.ts` — la clave en la declaración global de `Express.Request`.
6. `models/factorModels.test.ts:150-155` — ampliar: ese test usa `toHaveProperty`, así que
   **no detecta** una columna que esté en la migración y falte en el modelo.

- [ ] **Paso 4: `sellarContrasena` en `sessionPromotion.ts`**

```ts
/**
 * Marca que esta sesión acaba de confirmar su contraseña.
 *
 * 🔴 **No re-sella dentro de la ventana.** El `WHERE` es lo que hace real la
 * promesa de «diez minutos fijos, sin renovarse»: sin él, cada confirmación
 * mueve la fecha y la ventana se sostiene indefinidamente sola.
 *
 * **Solo la llama la rama sin-factor de `requireStepUp`.** Una cuenta CON
 * factor no gana ventana tecleando su contraseña — si lo hiciera, podría probar
 * su factor una sola vez en la vida de la sesión y después mantener abiertas las
 * rutas de credenciales con la contraseña sola.
 */
export async function sellarContrasena(id_sesion: string): Promise<boolean> {
  const limite = new Date(Date.now() - STEP_UP_WINDOW_MINUTES * 60_000);
  const [filas] = await SesionModel.update(
    { password_confirmed_at: new Date() },
    {
      where: {
        id: id_sesion,
        revoked_at: null,
        [Op.or]: [
          { password_confirmed_at: null },
          { password_confirmed_at: { [Op.lt]: limite } },
        ],
      },
    },
  );
  return filas > 0;
}
```

- [ ] **Paso 5: la lectura en la puerta — dentro de la rama sin-factor, NO en un OR**

🔴 `satisfecho` **no cambia**. La columna se consulta después de que `tieneAlgunFactor` haya
respondido `false`:

```ts
      // La ventana de una cuenta sin ningún factor. Se consulta AQUÍ y no en
      // `satisfecho`, treinta líneas arriba, y la diferencia es de seguridad:
      // en `satisfecho` esto sería un OR que se evalúa ANTES de la comprobación
      // de factor, y entonces una cuenta CON factor podría probarlo una vez y
      // después mantener abiertas las rutas de credenciales con la contraseña
      // sola, re-sellando cada vez. Aquí `tieneAlgunFactor` ya dijo `false`.
      const confirmadoHace =
        user.password_confirmed_at === null
          ? NaN
          : Date.now() - new Date(user.password_confirmed_at).getTime();
      const ventanaDeContrasena =
        confirmadoHace >= 0 && confirmadoHace <= STEP_UP_WINDOW_MINUTES * 60_000;
      if (ventanaDeContrasena && !sinVentana) {
        next();
        return;
      }
```

Y tras aceptar la contraseña: `await sellarContrasena(user.id_sesion);` — **con `await`**. Un
`void` deja la siguiente petición de la ventana contestando 403.

- [ ] **Paso 6: verificar la cadena entera**

Run: `cd api && npm run typecheck && npx vitest run src/`
Esperado: los dos tests del paso 1 en verde. **Si el primero sigue rojo, falta una de las seis
piezas** — el typecheck no lo dirá.

- [ ] **Paso 7: commit**

```bash
git add src/interfaces/index.ts src/models/sesion.model.ts src/models/factorModels.test.ts src/auth/sessionStore.ts src/middleware/authenticate.ts src/app.ts src/auth/sessionPromotion.ts src/middleware/requireStepUp.ts src/app.auth.test.ts
git commit -m "feat(auth): a correct password opens the ten-minute window for factor-less accounts"
```

---

# Tarea 6 — El sub-recurso `PUT /api/usuario/:id/rol`

**Por qué.** `PUT /api/usuario/:id` escribe `id_rol` de terceros
(`usuario.controller.ts:417-420`, `:460-462`, aplicado en `:540`) y su único freno es «no
cambies tu propio rol». Con esa ruta en ventana, una petición convierte a quien tenga tu
cookie en administrador **con sus propias credenciales** — que sobrevive a cambiar la
contraseña, a `logout-all`, al reset de factores y al rescate.

**Ficheros:**
- Crear: `api/src/controllers/usuarioRol.controller.ts` y su `.test.ts`
- Modificar: `api/src/routes/usuario.routes.ts`, `api/src/controllers/usuario.controller.ts:417-462`
- Modificar: `api/src/routes/routeGuards.test.ts` (la ruta nueva en las dos tablas)

**Interfaces:**
- Produce: `asignarRol(req, res)`; ruta `PUT /api/usuario/:id/rol`, cuerpo `{ id_rol: number }`.

- [ ] **Paso 1: los tests que fallan**

```ts
it("PUT /usuario/:id ya no puede cambiar el rol", async () => {
  // El agujero: con esa ruta en ventana, una petición y el atacante es admin.
  const res = await agente.put("/api/usuario/9").send({ id_rol: 1, nombre: "x" });
  expect(res.status).toBe(200);
  expect(await rolDe(9)).not.toBe(1); // el campo se ignora, no se aplica
});

it("PUT /usuario/:id/rol exige la contraseña aunque la ventana esté abierta", async () => {
  await abrirVentana(agente);
  const res = await agente.put("/api/usuario/9/rol").send({ id_rol: 1 });
  expect(res.status).toBe(403);
  expect(res.body.motivo).toBe(MOTIVO_CONTRASENA_REQUERIDA);
});

it("PUT /usuario/:id/rol rechaza cambiarte el rol a ti mismo", async () => {
  const res = await agente.put("/api/usuario/7/rol").send({ id_rol: 1, stepup_password: BUENA });
  expect(res.status).toBe(403);
});
```

- [ ] **Paso 2: verlos fallar** — el segundo con 404 (la ruta no existe).

- [ ] **Paso 3: sacar `id_rol` de la allowlist**

En `usuario.controller.ts`, quitar `id_rol` de `ROLE_ASSIGNMENT_FIELDS` y dejar el comentario
que explique adónde se fue y por qué (el escenario de la cookie dentro de la ventana).

- [ ] **Paso 4: el controlador nuevo** — `asignarRol` con: comprobar que el rol existe y no
  está archivado, rechazar `Number(id) === req.user.id` con la misma frase que
  `permiso.controller.ts:119-121`, escribir, y una línea de bitácora `severity: "warning"`
  con el rol anterior y el nuevo.

- [ ] **Paso 5: el montaje**

```ts
// El único sitio que escribe el `id_rol` de otra cuenta. Sale de
// `PUT /usuario/:id` porque esa ruta pasa a la ventana y es también con la que
// se editan los datos del propio perfil: dejarla fuera devolvía la doble
// petición de contraseña al sitio donde empezó todo este trabajo.
//
// `sinVentana` porque asignar un rol es repartir autoridad, y el criterio de la
// spec §4.1 es el mismo que deja fuera a `POST /usuario/`: lo que sobrevive a
// cambiar la contraseña, a cerrar todas las sesiones y al rescate cuesta la
// contraseña siempre.
router.put(
  "/:id/rol",
  requirePermission("roles", "editar"),
  requireStepUp({ sinVentana: true }),
  asignarRol,
);
```

🔴 **Corrección medida (2026-09-08):** una versión anterior de este plan decía que la ruta
debía ir **antes** de `router.put("/:id", ...)` y que `routeOrder.test.ts` lo comprobaba.
**Las dos cosas eran falsas.** El orden no importa: `PUT /:id` casa `/7`, no `/7/rol` — un
segmento contra dos, no hay colisión. Y ese test no cubre el caso: su `patron("/:id")` es
`^/[^/]+$`. Medido moviendo la ruta detrás de sus dos vecinas: 139/139 en verde. Se coloca
donde se lea mejor, y no hace falta testigo de algo que no puede romperse.

- [ ] **Paso 6: verificar** — `cd api && npx vitest run src/routes src/controllers/usuarioRol.controller.test.ts`

- [ ] **Paso 7: commit**

```bash
git add src/controllers/usuarioRol.controller.ts src/controllers/usuarioRol.controller.test.ts src/controllers/usuario.controller.ts src/routes/usuario.routes.ts src/routes/routeGuards.test.ts
git commit -m "feat(usuario): move role assignment to its own sub-resource, behind the password"
```

---

# Tarea 7 — Apagar `sinVentana` en las 8 rutas

**Ficheros:** los siete `*.routes.ts`, `api/src/routes/routeGuards.test.ts`.

- [ ] **Paso 1: reescribir `STEP_UP_OPTIONS` primero**

🔴 **Las tres opciones por fila.** Siete rutas necesitan `permiteOnboarding: true` y una
necesita `toleraFactorIlegible: true`; escribir la tabla con una sola columna vuelve a sellar
la sala (`auth.routes.ts:180-189` lo midió) y deja el servidor sin arrancar
(`requireStepUp.ts:282-287` lanza al montar).

Copiar la tabla de la spec §4.1 fila a fila. Las 8 que se apagan:
`PUT /api/usuario/username/:id`, `PUT /api/usuario/:id`, `PATCH /api/usuario/:id/restore`,
los cuatro de `rol`, y `DELETE /api/auth/sessions/:id` (que ya estaba apagada).
La única que se **enciende**: `POST /api/auth/email/send`, conservando `permiteOnboarding: true`.

- [ ] **Paso 2: verlo fallar**

Run: `cd api && npx vitest run src/routes/routeGuards.test.ts`
Esperado: FAIL con el diff de la tabla contra los montajes. Ese diff **es la lista de trabajo**
del paso siguiente.

- [ ] **Paso 3: los montajes**, uno por uno, siguiendo el diff.

- [ ] **Paso 4: el alambre trampa de D6**

`routeGuards.test.ts:1770-1818` afirma `sinVentana === true` sobre **toda** escritura de
`/usuario`, `/rol` y `/permiso`, y su docstring dice que existe para fallar ante *«un revert
del tipo "quitemos la contraseña de la matriz de permisos, que es un engorro"»*.

🔴 **No se borra: se recorta.** Pasa a afirmar `sinVentana === true` sobre la lista nominal de
las 15, y su docstring dice que la reversión la autorizó Isaias el 2026-09-08 con alcance
recortado, con enlace a la spec §4.1. Un alambre trampa borrado no protege nada.

- [ ] **Paso 5: verificar** — `cd api && npm test`

- [ ] **Paso 6: commit**

```bash
git add src/routes
git commit -m "feat(auth): the ten-minute window covers ordinary admin writes"
```

---

# Tarea 8 — Borrar `apagarLaMecha` y cerrar el rodeo de la rotación de sesión

**Por qué.** El plazo de catorce días se renueva en bucle: verificas el correo (el plazo se
borra), cambias el correo (la verificación se borra, el plazo sigue borrado), vuelves a
entrar → catorce días frescos. La vuelta más barata es registrar y borrar una passkey, que no
necesita buzón. La causa es que `apagarLaMecha` **borra la fecha**; si deja de borrarla, el
siguiente login lee la original y no re-estampa.

**Ficheros:** `api/src/auth/sessionPromotion.ts`, `api/src/controllers/{email,totp,webauthn}.controller.ts`,
`api/src/auth/sessionPromotion.test.ts`, `api/src/controllers/usuario.controller.ts:962-970`.

- [ ] **Paso 1: los tests que fallan**

```ts
it("registrar un factor y borrarlo no compra un plazo nuevo", async () => {
  const agente = request.agent(app);
  await login(agente, cuentaSinFactor);          // día 1: se estampa el plazo
  const plazoOriginal = await plazoDe(cuentaSinFactor.id);
  await registrarPasskey(agente);
  await borrarPasskey(agente);
  await agente.post("/api/auth/logout");
  await login(agente, cuentaSinFactor);

  expect(await plazoDe(cuentaSinFactor.id)).toEqual(plazoOriginal);
});

it("cambiar la contraseña no exime a la sesión nueva del plazo vencido", async () => {
  // El rodeo: `issueSession` recibía el estado EFECTIVO y no pasaba por
  // `estadoInicialDeSesion`, así que se podía conservar el ERP cambiando la
  // contraseña cada 29 días.
  await vencerPlazo(cuentaSinFactor.id);
  const res = await agente.put("/api/usuario/userpass/7").send({ pass: "n", oldPass: "v", stepup_password: "v" });
  expect(res.status).toBe(200);
  const siguiente = await agente.get("/api/usuario/7");
  expect(siguiente.status).toBe(403);
  expect(siguiente.body.code).toBe(CODIGO_FACTOR_PENDIENTE);
});
```

- [ ] **Paso 2: verlos fallar** — el primero con fechas distintas, el segundo con 200.

- [ ] **Paso 3: borrar las tres llamadas y la función**

Fuera `email.controller.ts:586`, `totp.controller.ts:412`, `webauthn.controller.ts:298`, la
función de `sessionPromotion.ts:207-215` y su test (`sessionPromotion.test.ts:162-169`). En el
sitio de la función, un comentario-lápida:

```ts
// `apagarLaMecha` vivía aquí y ponía `usuarios.mfa_grace_until` a NULL al
// registrar un factor. Borrada el 2026-09-08: era la causa del bucle que
// regalaba catorce días nuevos cada vez que alguien registraba un factor y lo
// borraba (la vuelta barata era una passkey, que no necesita buzón).
//
// Se descartó la alternativa —una columna `mfa_grace_started_at` que recordase
// que el plazo ya se gastó— porque rompía en silencio tres cosas: la gracia de
// rescate de 24 h (`rescueCore.ts:224-228` devuelve NULL para un plazo NULL, y
// el administrador se queda sin ninguna palanca), el indulto manual
// documentado en `factorInventory.ts:530-541`, y la capacidad de
// `estadoEfectivo` de estrechar una sesión viva.
//
// Coste conocido: a quien marcó «recordar este equipo» se le pedirá el factor
// una vez al vencer su plazo, porque `esPruebaDeFactor` declara que
// `'dispositivo'` no es prueba. Sale por `/api/auth/mfa/verify`, abierta a
// `onboarding`.
```

- [ ] **Paso 4: cerrar el rodeo** — en `usuario.controller.ts:970`, que `issueSession` pase por
  `estadoInicialDeSesion` como el login, en vez de arrastrar `loggedUser.estado`.

- [ ] **Paso 5: verificar** — `cd api && npx vitest run src/auth src/controllers src/app.auth.test.ts`

- [ ] **Paso 6: commit**

```bash
git add src/auth/sessionPromotion.ts src/auth/sessionPromotion.test.ts src/controllers/email.controller.ts src/controllers/totp.controller.ts src/controllers/webauthn.controller.ts src/controllers/usuario.controller.ts
git commit -m "fix(auth): the grace period is granted once, not once per factor deleted"
```

---

# Tarea 9 — `stepup_password` en la redacción de logs

**Por qué.** `REDACT_PATHS` (`logger.ts:118-180`) tiene `password` y `*.password`, y **pino
compara claves exactas**: `stepup_password` no casa con ninguna. El docstring de la lista
promete que *«un endpoint añadido mañana que reciba un `pass` está cubierto en el momento en
que se escribe»*, y para el campo que el 4D inventó eso es falso.

- [ ] **Paso 1: el test** — que `REDACT_PATHS` contiene `stepup_password` y `*.stepup_password`.
- [ ] **Paso 2: verlo fallar.**
- [ ] **Paso 3: añadir las dos claves**, con un comentario diciendo que pino compara claves
  exactas y por eso `password` no bastaba.
- [ ] **Paso 4: verlo pasar** — `cd api && npx vitest run src/utils`
- [ ] **Paso 5: commit** — `fix(logs): redact stepup_password, which "password" never covered`

---

# Tarea 10 — Cliente: el timeout que falta

**Por qué.** `comprobarToken` es la única petición de la ceremonia sin `timeout`
(`Login.api.ts:323`). Mientras cuelga, los dos botones están deshabilitados
(`StepUpDialog.tsx:568`, `:583`) y Escape se traga (`:410`): la aplicación queda bloqueada
tras una modal muerta, y la única salida pierde el formulario.

⚠️ **Esa función la usan también el arranque de `SesionProvider` y `LoginPage`.** El timeout va
**por llamada**, no global.

- [ ] **Paso 1: el test**

```tsx
it("no deja la ventana muerta si el refresco de sesión no vuelve", async () => {
  comprobarToken.mockImplementation(() => new Promise(() => {})); // nunca resuelve
  render(<StepUpDialog />);
  await userEvent.type(screen.getByLabelText(/contraseña/i), "buena");
  await userEvent.click(screen.getByRole("button", { name: "Confirmar" }));

  vi.advanceTimersByTime(TIMEOUT_CONFIRMACION_MS + 1);
  expect(await screen.findByRole("button", { name: "Cancelar" })).toBeEnabled();
});
```

- [ ] **Paso 2: verlo fallar** — debe fallar **por colgarse**, con el botón deshabilitado. Si
  falla por otra cosa, el test está mal montado.
- [ ] **Paso 3:** `comprobarToken(opciones?: { timeout?: number })`, y la llamada del diálogo
  pasa `TIMEOUT_CONFIRMACION_MS`. El arranque y el login **no cambian**.
- [ ] **Paso 4: verlo pasar** — `cd web && npx vitest run src/components/dialogs`
- [ ] **Paso 5: commit** — `fix(stepup): time out the session refresh so the dialog cannot hang`

---

# Tarea 11 — Cliente: la contraseña en el camino de éxito

`limpiarPassword` se llama solo en el `catch` (`stepUpInterceptor.ts:538`); el
`return await axios(config)` de `:518` no limpia nada, así que tras un reintento correcto
`response.config.data` sigue siendo `{"...":"...","stepup_password":"..."}`.

- [ ] **Paso 1: el test** — tras un reintento con éxito, `stepup_password` no está en
  `response.config.data`. **Sobre el objeto real, no sobre un doble.**
- [ ] **Paso 2: verlo fallar.**
- [ ] **Paso 3:** limpiar también en el camino de éxito (un `finally`, o antes del `return`).
- [ ] **Paso 4: verlo pasar** — `cd web && npx vitest run src/api/stepUpInterceptor.test.ts`
- [ ] **Paso 5: commit** — `fix(stepup): clear the password on the success path too`

---

# Tarea 12 — Cliente: el contador de reintentos y los mensajes

**Por qué.** `MAX_REINTENTOS = 2` y el camino honrado gasta uno, así que queda **uno** para
equivocarse cuando el presupuesto del servidor son cinco. Y de las ocho salidas del
interceptor (`:454`, `:463`, `:467`, `:489`, `:497`, `:501`, `:513`, `:539`) solo una emite
aviso: cancelar al crear un rol enseña «No se pudo crear el rol» sin decir que la cancelación
fue tuya.

⚠️ «Contar reenvíos y no pasos» **no es implementable**: los dos son reenvíos. La regla que sí
lo es: **alinear el contador con el `intentosRestantes` que el servidor ya manda**, y
reiniciarlo cuando cambia el `motivo`.

- [ ] **Paso 1: los tests** — que tres contraseñas mal tecleadas siguen abriendo la ventana
  mientras el servidor diga que quedan intentos; y que cancelar produce un error marcado como
  cancelación, distinguible de un fallo del servidor.
- [ ] **Paso 2: verlos fallar.**
- [ ] **Paso 3:** el contador lee `intentosRestantes`; el rechazo por cancelación lleva una
  marca propia que las pantallas puedan leer.
- [ ] **Paso 4: verlo pasar** — `cd web && npx vitest run src/api`
- [ ] **Paso 5: commit** — `fix(stepup): follow the server's remaining-attempts count, and say when a cancel was a cancel`

---

# Tarea 13 — Cliente: C5, encadenar ceremonias

**Por qué.** La ventana se abre con los datos del **primer** rechazo y su resultado se entrega
a todas las peticiones encoladas (`stepUpInterceptor.ts:339`). El discriminante no es `motivo`
—dos rutas con carencias distintas contestan las dos `sin-factor-reciente`— sino el par
**`(motivo, exigeContrasena)`**, que la Tarea 3 ya hace viajar.

🔴 **Encadenar, no apilar.** `StepUpDialog` guarda **una sola** ceremonia (`:71`) y su
resolvedor la sobrescribe sin condiciones (`:146-171`): abrir una segunda pisa la primera y
deja sus peticiones **ni resueltas ni rechazadas**, que es el fallo que
`stepUpInterceptor.ts:145-153` está escrito para evitar.

- [ ] **Paso 1: el test** — dos peticiones con pares distintos: la segunda **espera** a que la
  primera termine y abre la suya después; ninguna queda sin resolver.
- [ ] **Paso 2: verlo fallar** — hoy la segunda reusa la ceremonia de la primera.
- [ ] **Paso 3:** guardar el par de la ceremonia viva; si no coincide, `await` a que termine y
  entonces abrir. **No tocar el diálogo.**
- [ ] **Paso 4: verlo pasar** — `cd web && npx vitest run src/api/stepUpInterceptor.test.ts`
- [ ] **Paso 5: commit** — `fix(stepup): a queued request with a different need waits for its own ceremony`

---

# Tarea 14 — Los tres campos, el texto del diálogo, y las DOS mitades de `/email/send`

🔴 **Ampliación del 2026-09-09, hallazgo de la Tarea 7.** Esta tarea era solo de cliente y le
faltaba su mitad de servidor. La spec §4.3 dice que la comprobación de contraseña de
`POST /auth/email/send` **sube del controlador a la puerta**. La Tarea 7 ya encendió
`sinVentana` en esa ruta, así que la puerta ya la exige — pero **ninguna tarea quitaba la
comprobación del controlador**: `email.controller.ts:327` sigue contestando **400** si falta
`pass`.

Como esta tarea retira el campo `pass` del cliente y los dos repos salen juntos, sin esto
`/auth/email/send` **contestaría 400 a todo el mundo** — y es la única puerta por la que se
sale de `onboarding`. O sea: nadie podría verificar su correo, y por tanto nadie podría montar
un TOTP.

**Las dos mitades van en esta tarea y se revisan juntas**, porque separarlas es exactamente lo
que crea la ventana de rotura. Arrastra `email.controller.test.ts` y el test «leaves the doors
that finish the setup open», cuyo 400 tiene que pasar a venir de la puerta y no del handler.

Los campos que se retiran son **tres**, y el discriminante **no es** «su ruta conserva la
contraseña» —`PerfilAcceso.tsx:224` la conserva y aun así se retira— sino **qué campo del
cable alimentan**: los que alimentan un `oldPass`/`pass` propio del controlador mueren cuando
su controlador deja de leerlos.

| Dónde | Campo |
|---|---|
| `PerfilAcceso.tsx:124` | `userPass` |
| `UsuarioDetallePage.tsx:611-616` | `currentPassUser`, enviado como `oldPass` en `:172-175` |
| `PerfilAcceso.tsx:224` + `Login.api.ts:195` | el `pass` del correo |

**Se quedan los siete** de `Mfa.api.ts:96/138/161/185` y `Webauthn.api.ts:41/63/280`: mandan
`stepup_password` a rutas sin ventana.

⚠️ `PerfilPage.test.tsx` alcanza esos campos con `getByLabelText`, que **lanza ante una
coincidencia ambigua**. Leer la cabecera de `PerfilAcceso.tsx:38-61` antes de tocar
cualquier etiqueta: dice qué frases son load-bearing y por qué.

- [ ] **Paso 1: los tests** — que el editor de nombre de usuario ya no pide contraseña, y que
  guardar abre la ventana en su lugar. Y que el diálogo **dice para qué es y cuánto dura**.
- [ ] **Paso 2: verlos fallar.**
- [ ] **Paso 3:** retirar los tres campos y su estado; `updateUserName` en el servidor deja de
  exigir `oldPass` (reescribiendo su docstring de `:590-660`, que conserva el argumento de por
  qué un nombre de usuario merece protección pero ya no dice dónde se comprueba);
  `chargeConfirmBudgetOnSelfChange` **se desmonta de `/username/:id`** y se conserva en
  `/userpass/:id`, con sus 66 líneas de docstring reescritas para hablar de una ruta.
- [ ] **Paso 4: verlo pasar** — `cd web && npm run test` y `cd api && npm test`
- [ ] **Paso 5: commit** — `feat(perfil): the dialog asks for the password, the form does not`

---

# Tarea 15 — Cliente: trocear `StepUpDialog.tsx`

594 líneas y **doce** `useState`. Las tareas 10-13 tocan ese estado. Sale
`useStepUpCeremony.ts` con el estado y las acciones; el componente queda presentacional.

- [ ] **Paso 1:** el test del hook, sin DOM: transiciones de estado.
- [ ] **Paso 2: verlo fallar.**
- [ ] **Paso 3:** extraer. **Sin cambiar comportamiento** — los tests de
  `StepUpDialog.test.tsx` son la red y no deben tocarse.
- [ ] **Paso 4: verlo pasar** — `cd web && npx vitest run src/components/dialogs`
- [ ] **Paso 5: commit** — `refactor(stepup): extract useStepUpCeremony from the dialog`

---

# Tarea 16 — Los catorce bloques de comentario

**Por qué.** En este repositorio los comentarios largos afirman propiedades de seguridad, y
una auditoría del 2026-09-08 encontró once que ya eran falsos — uno de ellos **defendía
activamente** un agujero. Los que este arco deja obsoletos son parte del arco.

- [ ] **Paso 1:** reescribir, uno por uno:
  `requireStepUp.ts:34-56`, `:112-123`, `:138` («six prefixes» son siete), `:159-161` (afirma
  falsamente que webauthn pide correo verificado), `:180-195`, `:476-561`;
  `rol.routes.ts:29-43` (bloque D6 + el helper sin uso);
  `usuario.routes.ts:30-95`, `:114-131`, `:289-297`;
  `usuario.controller.ts:590-660`;
  `factorInventory.ts:530-541` (el indulto manual), `:576-590`;
  `sessionState.ts:318`; `routeGuards.test.ts:540-548`; `auth.routes.ts:114-117`.

🔴 **Tres más, encontrados por la revisión de la Tarea 7 y que faltaban en esta lista:**
`permiso.routes.ts:45-47` (dice que no existe equivalente de «contraseña probada hace poco»,
que es justo lo que este arco crea), `auth.routes.ts:206-207` (dice que la puerta lee el cupo
«sin gastar», falso desde la Tarea 1: cobra siempre y devuelve la correcta), y
`usuario.routes.ts:170-206` (describe la rama del pase libre como viva; la borró la Tarea 3).
- [ ] **Paso 2: verificar** — `cd api && npm run lint && npm test`
- [ ] **Paso 3: commit** — `docs(auth): the comments say what the code does now`

---

# Tarea 17 — Los testigos que se pierden, sustituidos

**Por qué.** Siete tests se ponen rojos por este arco, y reescribirlos «para que pasen» borra
la propiedad que protegían. La regla del repositorio es que **un test que se ajusta para que
pase es un test que deja de servir**. Cada uno necesita un testigo nuevo, no un `expect`
nuevo.

**Ficheros:** `api/src/app.auth.test.ts`, `api/src/routes/{totp,recoveryCodes}.routes.test.ts`.

| Test | Qué protegía | Sustituto |
|---|---|---|
| `app.auth.test.ts:1087` | La única aserción IDOR del stack real: el `where` lleva `id_usuario: YO` | El mismo caso **con el sello fresco**, que es el único escenario en el que esa consulta se ejecuta ahora |
| `:1101` | «404 y **no 403**» para la sesión de otro | Igual, con el sello fresco: la puerta ya no contesta antes |
| `:1114` | Que no se manda un id malformado a una columna UUID. 🔴 **Seguiría en verde por otro motivo** | Igual, con el sello fresco |
| `:1414` | Que el renombrado y el cambio de contraseña comparten **un** cubo, no uno cada uno. Su comentario dice que es la aserción *«que un segundo `rateLimit()` rompería, y nada más lo haría»* | El par `PUT /userpass/:id` (contraseña mal → 401 → cobra) y `POST /auth/email/send`, que monta el limitador por su cuenta |
| `:1821` | El único testigo montado de `LockoutPolicy`: una cuenta bloqueada puede renombrarse con su contraseña | Trasladarlo a `PUT /userpass/:id`, que conserva `oldPass` |
| `:2032`, `:2117-2126` | Que una petición sin contraseña triunfaba y luego era rechazada al aparecer un factor; y la línea `STEP_UP_SKIPPED` | Se borran con la rama. Su propiedad —«la puerta se cierra sola cuando aparece un factor»— pasa a estar cubierta por el test de la Tarea 3 |
| `totp.routes.test.ts:185-205`, `recoveryCodes.routes.test.ts:122-151` | Guardas anti-mutación de C1 y C14: van rojas si alguien quita la contraseña de esas rutas | Reescribir con **sello fresco y sin contraseña**, que es lo único que seguirá distinguiendo los dos modos. El segundo test de `recoveryCodes.routes.test.ts:139-155` ya tiene esa forma y sirve de plantilla |

- [ ] **Paso 1:** para cada fila, **leer el comentario del test original antes de tocarlo**.
      Varios dicen por escrito qué defecto los hizo nacer.
- [ ] **Paso 2:** escribir el sustituto y verlo fallar contra el código **anterior** al arco
      (`git stash` del trabajo, correr, `git stash pop`). Si pasa en verde contra el código
      viejo, no está protegiendo lo que su nombre dice.
- [ ] **Paso 3:** borrar o adaptar el original.
- [ ] **Paso 4: verificar** — `cd api && npm test`
- [ ] **Paso 5: commit** — `test(auth): replace the witnesses this arc would have silently dropped`

---

# Cierre

- [ ] `cd api && npm run typecheck && npm run lint && npm test`
- [ ] `cd web && npm run lint && npm run test`
- [ ] Revisar el diff completo antes de commitear — **hay otras sesiones trabajando en el
      mismo árbol**. Añadir ficheros por nombre; si uno mezcla trabajo ajeno, dejarlo fuera y
      decírselo a Isaias.
- [ ] Un solo commit del arco, mensaje en inglés, con el bloque `SIGNED-OFF`
      (`AUTHOR: Isaias Salas Montesinos (isaias@donefy.io)`) si la guía del repo lo pide.
- [ ] **No desplegar.** §9 de la spec: los dos repos salen juntos, en una ventana, con caída de
      login, y hay cuatro pasos previos que son de Isaias (rama de Coolify, rotar
      `JWT_SECRET`, armar la migración aparcada, y decidir si son nueve cuentas o quince).
