import { fn, col, where as sequelizeWhere } from "sequelize";
import type { Utils } from "sequelize";

/**
 * How to look an account up by the name somebody typed.
 *
 * Usernames are unique case-insensitively — `usuarios_user_uniq` is a partial
 * index on `lower("user")` — so the only correct way to find one is to compare
 * the same way the index does. Anything else compares bytes, and bytes say
 * `Omar Mita` and `omar mita` are two different people.
 *
 * This lived twice and was missing a third time. The username collision check
 * folded case, the per-account rate-limit bucket folded case, the index folds
 * case — and the login's own lookup did not: it was `findOne({ where: { user }
 * })`. Anybody whose stored name carries a capital and who typed it in lower
 * case fell into the unknown-user branch, which since the uniform message
 * answers "Usuario o contraseña incorrectos" — indistinguishable from a wrong
 * password. They retried, and the per-account bucket eventually answered 429.
 * There was no way in and nothing said why, and they could not work around it
 * by making the lower-case variant either, because the collision check would
 * refuse the name as taken.
 *
 * One function so the four places cannot drift apart again. It also means the
 * query is an equality against `lower("user")`, which is exactly what the index
 * covers, so Postgres uses it instead of scanning.
 */
export function whereUsernameIs(user: string): Utils.Where {
  return sequelizeWhere(fn("lower", col("user")), user.toLowerCase());
}
