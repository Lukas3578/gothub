/**
 * Adressen der bereitgestellten Umgebung.
 *
 * Diese Datei ist die EINZIGE Stelle, an der die öffentlichen URLs stehen.
 * Umgebungsvariablen haben Vorrang; die Werte hier greifen, wenn in der
 * Laufzeitumgebung nichts gesetzt ist. Dadurch läuft ein Deployment ohne
 * Konfiguration im Hosting-Dashboard, und ein Umzug auf andere Adressen
 * berührt genau eine Datei.
 *
 * Wichtig: Frontend und API liegen auf verschiedenen Hosts. Das hat Folgen
 * für Cookies und CSRF, die in middleware/context.ts erklärt sind.
 */

/** Öffentliche Adresse der API. Erscheint in Klon-URLs und E-Mail-Links. */
export const DEFAULT_PUBLIC_API_URL = 'https://gothub-q0p7.onrender.com';

/** Öffentliche Adresse des Frontends. Bestimmt die erlaubte CORS-Origin. */
export const DEFAULT_PUBLIC_WEB_URL = 'https://forge-wuj4.onrender.com';

/**
 * Weitere Origins, die auf die API zugreifen dürfen.
 *
 * Die lokale Entwicklungsadresse steht hier, damit ein Entwickler gegen die
 * bereitgestellte API arbeiten kann, ohne die Konfiguration zu ändern. Jeder
 * Eintrag hier darf Anmeldedaten senden und CSRF-Tokens lesen – die Liste
 * bleibt deshalb kurz und wird nicht aus Benutzereingaben gefüllt.
 */
export const ADDITIONAL_ALLOWED_ORIGINS = ['http://localhost:5173'];

/**
 * True, wenn zwei URLs auf demselben Host liegen.
 *
 * Entscheidet, ob Cookies als Same-Site gelten. Bei verschiedenen Hosts
 * braucht der Browser `SameSite=None; Secure`, sonst sendet er das Cookie bei
 * fetch-Aufrufen nicht mit.
 */
export function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}
