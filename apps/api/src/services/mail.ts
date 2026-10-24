/**
 * E-Mail-Versand.
 *
 * Zwei Transportwege:
 *  - `console` (Standard in der Entwicklung): die Nachricht wird protokolliert.
 *    Bewusst sichtbar gemacht statt stillschweigend verworfen – beim Testen
 *    muss der Bestätigungslink auffindbar sein.
 *  - `smtp`: echter Versand über einen SMTP-Server.
 *
 * Der Transport wird beim ersten Versand aufgebaut und danach
 * wiederverwendet; nodemailer hält die Verbindung selbst offen.
 */

import { createTransport, type Transporter } from 'nodemailer';
import { config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!config.mail.host) {
    throw new Error(
      'MAIL_TRANSPORT=smtp gesetzt, aber SMTP_HOST fehlt. Siehe .env.example.',
    );
  }

  const port = config.mail.port ?? 587;

  transporter = createTransport({
    host: config.mail.host,
    port,
    // Port 465 spricht von Beginn an TLS; auf 587 wird per STARTTLS
    // hochgestuft. Beides ergibt eine verschlüsselte Verbindung.
    secure: port === 465,
    requireTLS: port !== 465,
    auth: config.mail.user
      ? { user: config.mail.user, pass: config.mail.password ?? '' }
      : undefined,
    // Ein hängender Mailserver darf keine Anfrage blockieren.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 3,
  });

  return transporter;
}

/**
 * Verschickt eine Nachricht.
 *
 * Wirft bei Fehlschlag. Die Aufrufer entscheiden, ob das die Aktion scheitern
 * lässt: eine Registrierung soll nicht an einem Mailserver scheitern, ein
 * ausdrücklich angeforderter Versand dagegen schon.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  if (config.mail.transport === 'console') {
    console.log(
      [
        '',
        '--- E-MAIL (Transport: console) ---',
        `An:      ${message.to}`,
        `Betreff: ${message.subject}`,
        '',
        message.text,
        '-----------------------------------',
        '',
      ].join('\n'),
    );
    return;
  }

  await getTransporter().sendMail({
    from: config.mail.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
}

/**
 * Prüft die SMTP-Verbindung.
 *
 * Wird vom Admin-Bereich aufgerufen, damit eine Fehlkonfiguration auffällt,
 * bevor jemand vergeblich auf eine Bestätigungsmail wartet.
 */
export async function verifyMailTransport(): Promise<{ ok: boolean; detail: string }> {
  if (config.mail.transport === 'console') {
    return { ok: true, detail: 'Transport "console": Nachrichten gehen in das Serverprotokoll.' };
  }

  try {
    await getTransporter().verify();
    return { ok: true, detail: `SMTP unter ${config.mail.host}:${config.mail.port ?? 587} erreichbar.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Unbekannter Fehler.' };
  }
}

/** Schließt den Transport beim Herunterfahren. */
export function closeMailTransport(): void {
  transporter?.close();
  transporter = null;
}
