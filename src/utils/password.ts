import { PASSWORD_MIN_LENGTH } from "../config/security.js";

/**
 * The passwords that are tried first, and the ones this workforce would pick.
 *
 * A short embedded list rather than a dependency: the value is in blocking what
 * a guesser starts with, and that is a few dozen strings, not a package with a
 * megabyte of them. Spanish entries because the users are Spanish-speaking and
 * an English-only list would let `contraseña123` straight through.
 */
const COMUNES = new Set([
  "123456789012", "contraseña", "contrasena", "password", "passw0rd",
  "qwertyuiop", "administrador", "administrator", "1234567890",
  "osefi", "osefisrl", "lefitel", "telecomunicaciones",
  "bienvenido", "welcome", "iloveyou", "abcdefghijkl",
  "contraseña1", "password1", "password123", "contraseña123",
  "qwerty123", "qwertyuiop123", "123456", "12345678",
]);

/**
 * Why this password is not acceptable, or null if it is.
 *
 * Length is the only rule with teeth. Composition rules are absent on purpose:
 * they push people toward one predictable shape and toward writing the result
 * down, which trades an attack nobody was running for one that works.
 *
 * Measured on the *trimmed* password, never on the raw one: "clave1" padded
 * out with six trailing spaces is a six-character secret wearing a
 * twelve-character costume, and measuring the raw string let it through.
 * Spaces *between* words ("el poste de la esquina") are not padding and stay
 * counted either way, since trimming only touches the two ends.
 *
 * What gets hashed and stored is a separate matter, and is never trimmed —
 * see auth/credentials.ts's own rule that a password is a secret and every
 * character in it counts. Trimming what is stored would silently accept a
 * shorter secret than the one chosen and would break any account whose
 * password legitimately starts or ends with a space; this function only
 * ever reads `pass`, it does not decide what gets saved.
 */
export function validarPassword(pass: string): string | null {
  const recortada = pass.trim();

  // Spread rather than `.length`: a string's length counts UTF-16 code units,
  // so an emoji or some accented forms would count as two.
  const caracteres = [...recortada];

  if (caracteres.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }

  const normalizada = recortada.toLowerCase();
  if (COMUNES.has(normalizada)) {
    return "Esa contraseña es demasiado común. Elija otra.";
  }

  return null;
}
