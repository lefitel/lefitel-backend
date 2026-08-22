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
 */
export function validarPassword(pass: string): string | null {
  // Spread rather than `.length`: a string's length counts UTF-16 code units,
  // so an emoji or some accented forms would count as two.
  const caracteres = [...pass];

  if (caracteres.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }

  if (pass.trim().length === 0) {
    return "La contraseña no puede ser solo espacios.";
  }

  const normalizada = pass.trim().toLowerCase();
  if (COMUNES.has(normalizada)) {
    return "Esa contraseña es demasiado común. Elija otra.";
  }

  return null;
}
