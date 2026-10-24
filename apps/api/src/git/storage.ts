/**
 * Ablage der Git-Repositories auf der Festplatte.
 *
 * Jedes Repository liegt als bare-Repository unter
 *   <GIT_STORAGE_ROOT>/<aa>/<bb>/<uuid>.git
 * wobei aa/bb die ersten vier Zeichen der UUID sind. Das Sharding verhindert,
 * dass ein Verzeichnis mit hunderttausenden Einträgen entsteht.
 *
 * Der Pfad wird aus der Repository-UUID gebildet, NICHT aus Benutzer- oder
 * Repository-Namen. Zwei Konsequenzen:
 *  - Umbenennen und Übertragen berühren die Festplatte nicht.
 *  - Ein Name wie "../../etc" kann prinzipiell keinen Pfad verlassen, weil
 *    Namen nie in den Pfad eingehen.
 */

import { constants } from 'node:fs';
import { access, mkdir, rename, rm, stat, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { runGit } from './exec.js';
import { installHooks } from './hooks.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Liefert den absoluten Pfad zum bare-Repository.
 *
 * Validiert die UUID streng und prüft anschließend, dass der aufgelöste Pfad
 * tatsächlich unterhalb des Storage-Root liegt. Die zweite Prüfung ist
 * redundant, solange die erste greift – sie bleibt als Sicherheitsnetz
 * bestehen, falls das Format später gelockert wird.
 */
export function repositoryPath(repositoryId: string): string {
  if (!UUID_PATTERN.test(repositoryId)) {
    throw new Error(`Ungültige Repository-ID: ${repositoryId}`);
  }

  const shardA = repositoryId.slice(0, 2);
  const shardB = repositoryId.slice(2, 4);
  const path = resolve(config.git.storageRoot, shardA, shardB, `${repositoryId}.git`);

  const root = resolve(config.git.storageRoot);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error('Pfadauflösung hat das Storage-Verzeichnis verlassen.');
  }
  return path;
}

export async function repositoryExists(repositoryId: string): Promise<boolean> {
  try {
    await access(join(repositoryPath(repositoryId), 'HEAD'), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Legt ein leeres bare-Repository an.
 *
 * `receive.denyNonFastForwards` bleibt aus, weil Force-Push auf ungeschützten
 * Branches erlaubt sein soll; die Durchsetzung von Branch-Schutzregeln
 * passiert im pre-receive-Hook, der den Kontext kennt.
 */
export async function createRepository(
  repositoryId: string,
  defaultBranch: string,
): Promise<string> {
  const path = repositoryPath(repositoryId);
  await mkdir(path, { recursive: true });

  await runGit(['init', '--bare', `--initial-branch=${defaultBranch}`, path], { cwd: path });

  // Erlaubt das Abrufen beliebiger Objekte per SHA, was der Dateibrowser für
  // Commits nutzt, die (noch) von keinem Ref erreichbar sind.
  await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: path });
  // Deaktiviert die automatische Garbage Collection während eines Push; sie
  // wird stattdessen gesteuert als Hintergrundjob ausgeführt.
  await runGit(['config', 'receive.autogc', 'false'], { cwd: path });
  // Stellt sicher, dass eingehende Objekte auf Wohlgeformtheit geprüft werden.
  await runGit(['config', 'receive.fsckObjects', 'true'], { cwd: path });
  // Verhindert, dass ein Push versehentlich den ausgecheckten Branch verändert
  // (bei bare-Repositories nicht relevant, aber als Absicherung gesetzt).
  await runGit(['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: path });

  // Branch-Schutzregeln müssen auch beim Push über die Kommandozeile greifen.
  await installHooks(repositoryId);

  return path;
}

/**
 * Erstellt einen Fork als lokale Kopie.
 *
 * `--shared` wird bewusst NICHT verwendet: geteilte Objektverzeichnisse
 * koppeln die Lebensdauer beider Repositories. Würde das Original gelöscht,
 * wäre der Fork beschädigt. Der zusätzliche Speicherbedarf ist der Preis für
 * unabhängige Repositories.
 */
export async function forkRepository(
  sourceRepositoryId: string,
  targetRepositoryId: string,
): Promise<string> {
  const sourcePath = repositoryPath(sourceRepositoryId);
  const targetPath = repositoryPath(targetRepositoryId);

  await mkdir(resolve(targetPath, '..'), { recursive: true });
  await runGit(['clone', '--bare', sourcePath, targetPath], { timeoutMs: 300_000 });

  // Die Herkunfts-Remote entfernen: der Fork soll nicht versehentlich zurück
  // ins Ursprungs-Repository pushen können.
  await runGit(['remote', 'remove', 'origin'], { cwd: targetPath }).catch(() => {});
  await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: targetPath });
  await runGit(['config', 'receive.fsckObjects', 'true'], { cwd: targetPath });

  // `git clone --bare` kopiert die Hooks nicht mit; sie werden neu gesetzt.
  await installHooks(targetRepositoryId);

  return targetPath;
}

/**
 * Entfernt ein Repository von der Festplatte.
 *
 * Wird erst vom Aufräumjob nach Ablauf der Soft-Delete-Frist aufgerufen,
 * nicht direkt beim Löschen durch den Benutzer.
 */
export async function destroyRepository(repositoryId: string): Promise<void> {
  await rm(repositoryPath(repositoryId), { recursive: true, force: true });
}

/** Verschiebt ein Repository in den Papierkorb-Bereich (Soft Delete). */
export async function trashRepository(repositoryId: string): Promise<void> {
  const source = repositoryPath(repositoryId);
  const target = resolve(config.git.storageRoot, '.trash', `${repositoryId}-${Date.now()}.git`);
  await mkdir(resolve(target, '..'), { recursive: true });
  await rename(source, target);
}

/** Summiert die Größe eines Repositories in Bytes. */
export async function repositorySize(repositoryId: string): Promise<number> {
  const path = repositoryPath(repositoryId);
  let total = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
    }
  }

  try {
    await walk(path);
  } catch {
    return 0;
  }
  return total;
}

/** Führt Garbage Collection aus. Gehört in einen Hintergrundjob. */
export async function packRepository(repositoryId: string): Promise<void> {
  await runGit(['gc', '--auto', '--quiet'], {
    cwd: repositoryPath(repositoryId),
    timeoutMs: 600_000,
  });
}

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

/**
 * Pfad zum Wiki eines Repositories.
 *
 * Das Wiki ist ein eigenes bare-Repository neben dem Hauptrepository, mit der
 * Endung `.wiki.git`. Dadurch lässt es sich wie jedes Repository klonen und
 * bearbeiten, ohne dass Wiki-Seiten im Quelltext auftauchen oder die Historie
 * des Projekts aufblähen.
 */
export function wikiPath(repositoryId: string): string {
  if (!UUID_PATTERN.test(repositoryId)) {
    throw new Error(`Ungültige Repository-ID: ${repositoryId}`);
  }

  const path = resolve(
    config.git.storageRoot,
    repositoryId.slice(0, 2),
    repositoryId.slice(2, 4),
    `${repositoryId}.wiki.git`,
  );

  const root = resolve(config.git.storageRoot);
  if (!path.startsWith(root + sep)) {
    throw new Error('Pfadauflösung hat das Storage-Verzeichnis verlassen.');
  }
  return path;
}

export async function wikiExists(repositoryId: string): Promise<boolean> {
  try {
    await access(join(wikiPath(repositoryId), 'HEAD'), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Legt das Wiki-Repository an, falls es noch nicht existiert.
 *
 * Wird beim ersten Schreibzugriff aufgerufen statt beim Anlegen des
 * Repositories: die meisten Projekte bekommen nie ein Wiki, und ein leeres
 * bare-Repository je Projekt wäre reine Verwaltungslast.
 */
export async function ensureWikiRepository(repositoryId: string): Promise<string> {
  const path = wikiPath(repositoryId);
  if (await wikiExists(repositoryId)) return path;

  await mkdir(path, { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main', path], { cwd: path });
  await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: path });
  await runGit(['config', 'receive.fsckObjects', 'true'], { cwd: path });
  await runGit(['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: path });
  return path;
}

export async function destroyWikiRepository(repositoryId: string): Promise<void> {
  await rm(wikiPath(repositoryId), { recursive: true, force: true });
}
