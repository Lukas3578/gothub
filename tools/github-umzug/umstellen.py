#!/usr/bin/env python3
"""
Stellt ein Repo von GitHub auf gothub/Forge um (einmal im Repo-Ordner ausfuehren):

    python3 umstellen.py [--owner vortex] [--host https://git.vortexpvp.eu] [--dry-run]

Was passiert:
  1. .github/workflows/*.yml  ->  .forge/workflows/*.yml, angepasst:
       - runs-on ubuntu-*  -> self-hosted (unser Runner)
       - concurrency/permissions/defaults und Schritt-"id"/"timeout-minutes" raus
         (gibt es auf Forge nicht; ein Workflow mit diesen Schluesseln wuerde gar nicht laufen)
       - nach actions/checkout: Schritt, der den gh-Ersatz (tools/forge/gh) in den PATH legt
       - github.com/Marcinator31/... -> <host>/<owner>/...
     Workflows fuer Windows/macOS (runs-on windows-*/macos-*) kann unser Linux-Runner
     nicht ausfuehren: sie landen in tools/forge/nur-github/ und laufen nicht.
  2. tools/forge/gh wird angelegt (gh-Ersatz: release view/create/edit/upload/download/delete, api).
  3. gradle.properties: client_repo=Marcinator31/... -> <owner>/...
  4. Java-Quelltext: raw.githubusercontent.com/Marcinator31/<Repo>/<ref>/ -> <host>/<owner>/<Repo>/raw/<ref>/
     und github.com/Marcinator31 -> <host>/<owner>; Texte "GitHub" in der Beta-Ansicht -> "Vortex Git".

Danach: git add -A && git commit -m "Auf gothub umgestellt" && git push.
Im Repo auf gothub unter Einstellungen -> Secrets das Secret FORGE_TOKEN anlegen.
"""
import argparse, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OLD_OWNER = "Marcinator31"
DROP_KEYS_ANY = ("concurrency", "permissions", "defaults")
STEP_DROP = ("id", "timeout-minutes")


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


def drop_blocks(lines, keys, only_in_steps=False):
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        m = re.match(r"^(\s*)(-\s+)?([A-Za-z_-]+):", line)
        if m and m.group(3) in keys and not stripped.startswith("#"):
            base = indent_of(line) + (len(m.group(2)) if m.group(2) else 0)
            if m.group(2):
                # "- id: x" -> Listeneintrag behalten, nur den Schluessel entfernen
                rest_lines = []
                j = i + 1
                while j < len(lines) and (not lines[j].strip() or indent_of(lines[j]) > base):
                    j += 1
                # naechste Zeile des Schritts wird zum Listenanfang
                if j < len(lines) and indent_of(lines[j]) == base and not lines[j].lstrip().startswith("-"):
                    lines[j] = " " * indent_of(line) + "- " + lines[j].lstrip()
                    i = j
                    continue
                i = j
                continue
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or indent_of(lines[j]) > base):
                j += 1
            i = j
            continue
        out.append(line)
        i += 1
    return out


def convert_workflow(text, owner, host):
    notes = []
    if re.search(r"runs-on:\s*\[?\s*['\"]?(windows|macos)", text):
        return None, ["braucht Windows/macOS"]
    lines = text.splitlines()
    lines = drop_blocks(lines, DROP_KEYS_ANY)
    lines = drop_blocks(lines, STEP_DROP)
    if re.search(r"^\s*strategy:", "\n".join(lines), re.M):
        notes.append("WARNUNG: strategy/matrix gibt es auf Forge nicht -- von Hand in einzelne Jobs aufteilen")
    out = []
    for line in lines:
        line = re.sub(r"(runs-on:\s*)['\"]?ubuntu-[\w.]+['\"]?", r"\1self-hosted", line)
        if not line.lstrip().startswith("uses:"):
            line = line.replace(f"https://github.com/{OLD_OWNER}/", f"{host}/{owner}/")
            line = re.sub(rf"\b{OLD_OWNER}/", f"{owner}/", line)
            # git clone "https://github.com/$REPO.git" -> unsere Plattform
            line = re.sub(r"https://github\.com/(?=\$)", "${GITHUB_SERVER_URL}/", line)
        out.append(line)
    # gh-Ersatz nach dem Checkout in den PATH
    res, i, done = [], 0, False
    while i < len(out):
        line = out[i]
        res.append(line)
        i += 1
        if done or not re.match(r"^\s*(-\s+)?uses:\s*actions/checkout", line):
            continue
        # Einrueckung des "- " dieses Schritts suchen
        if re.match(r"^\s*-\s+", line):
            dash = indent_of(line)
        else:
            k = len(res) - 2
            while k >= 0 and not re.match(r"^\s*-\s+", res[k]):
                k -= 1
            dash = indent_of(res[k]) if k >= 0 else indent_of(line) - 2
        # Rest dieses Schritts uebernehmen (tiefer eingerueckt oder leer)
        while i < len(out) and (not out[i].strip() or indent_of(out[i]) > dash):
            res.append(out[i])
            i += 1
        res.append(" " * dash + "- name: gh-Ersatz fuer gothub")
        res.append(" " * (dash + 2) + 'run: chmod +x tools/forge/gh && echo "$GITHUB_WORKSPACE/tools/forge" >> "$GITHUB_PATH"')
        done = True
    return "\n".join(res) + "\n", notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default="vortex")
    ap.add_argument("--host", default="https://git.vortexpvp.eu")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    host = a.host.rstrip("/")
    root = os.getcwd()
    if not os.path.isdir(os.path.join(root, ".git")):
        sys.exit("Bitte im Repo-Ordner ausfuehren (dort, wo .git liegt).")

    def write(path, content):
        print(("[probe] " if a.dry_run else "") + "schreibe " + os.path.relpath(path, root))
        if not a.dry_run:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf8", newline="\n") as fh:
                fh.write(content)

    def remove(path):
        print(("[probe] " if a.dry_run else "") + "entferne " + os.path.relpath(path, root))
        if not a.dry_run:
            os.remove(path)

    wf_dir = os.path.join(root, ".github", "workflows")
    if os.path.isdir(wf_dir):
        for name in sorted(os.listdir(wf_dir)):
            if not re.search(r"\.ya?ml$", name):
                continue
            src = os.path.join(wf_dir, name)
            text = open(src, encoding="utf8").read()
            converted, notes = convert_workflow(text, a.owner, host)
            if converted is None:
                write(os.path.join(root, "tools", "forge", "nur-github", name), text)
                print(f"  {name}: {notes[0]} -- nach tools/forge/nur-github/ verschoben (laeuft nicht mehr)")
            else:
                write(os.path.join(root, ".forge", "workflows", name), converted)
                for n in notes:
                    print(f"  {name}: {n}")
            remove(src)

    gh_src = os.path.join(HERE, "gh")
    gh_dst = os.path.join(root, "tools", "forge", "gh")
    print(("[probe] " if a.dry_run else "") + "schreibe tools/forge/gh")
    if not a.dry_run:
        os.makedirs(os.path.dirname(gh_dst), exist_ok=True)
        shutil.copyfile(gh_src, gh_dst)
        os.chmod(gh_dst, 0o755)

    gp = os.path.join(root, "gradle.properties")
    if os.path.isfile(gp):
        t = open(gp, encoding="utf8").read()
        n = re.sub(rf"^(client_repo\s*=\s*){OLD_OWNER}/", rf"\g<1>{a.owner}/", t, flags=re.M)
        if n != t:
            write(gp, n)

    raw = re.compile(rf"https://raw\.githubusercontent\.com/{OLD_OWNER}/([^/\"]+)/(?:refs/heads/)?([^/\"]+)/")
    texts = [("Sent to GitHub", "Sent to Vortex Git"), ("sends it to GitHub", "sends it to Vortex Git"),
             ("Public on GitHub", "Public on Vortex Git")]
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "build", ".gradle", "node_modules", "build-port", "run")]
        for fn in filenames:
            if not fn.endswith((".java", ".kt", ".json", ".properties")) or fn == "gradle.properties":
                continue
            p = os.path.join(dirpath, fn)
            try:
                t = open(p, encoding="utf8").read()
            except (UnicodeDecodeError, OSError):
                continue
            n = raw.sub(lambda m: f"{host}/{a.owner}/{m.group(1)}/raw/{m.group(2)}/", t)
            n = n.replace(f"https://github.com/{OLD_OWNER}", f"{host}/{a.owner}")
            for old, new in texts:
                n = n.replace(old, new)
            if n != t:
                write(p, n)

    print("\nFertig. Jetzt: git add -A && git commit -m 'Auf gothub umgestellt' && git push")
    print("Nicht vergessen: im Repo auf gothub das Secret FORGE_TOKEN anlegen.")


if __name__ == "__main__":
    main()
