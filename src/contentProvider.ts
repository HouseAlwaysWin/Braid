/**
 * Serves file contents at a revision, so VS Code's own diff editor can show them.
 *
 * Two details decide whether this works:
 *
 * - **The URI path must end with the real filename.** VS Code picks the language mode - and
 *   therefore the syntax highlighting in the diff - from the path's extension. A URI of
 *   `braid-git:/abc123` opens every diff as plain text.
 * - **Content is addressed by blob OID, not by `<commit>:<path>`.** A renamed file has a different
 *   path on each side, so path addressing needs rename resolution that the raw diff already did
 *   for us.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';

export const SCHEME = 'braid-git';

interface Revision {
  readonly repo: string;
  /** null renders as an empty document - the missing side of an add or a delete. */
  readonly blob: string | null;
}

/**
 * Build a URI for one side of a diff. `path` is only ever used for the filename and language mode;
 * the content comes from `blob`.
 */
export function revisionUri(repo: string, path: string, blob: string | null, label: string): vscode.Uri {
  const query: Revision = { repo, blob };

  return vscode.Uri.from({
    scheme: SCHEME,
    // A leading slash plus the real path keeps both the filename and the folder context visible in
    // the diff editor's tab.
    path: `/${path}`,
    query: encodeURIComponent(JSON.stringify(query)),
    fragment: label,
  });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  private readonly git: Git;
  /** Blob content is immutable, so it is safe to cache for the session. */
  private readonly cache = new Map<string, string>();

  constructor(git: Git) {
    this.git = git;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let revision: Revision;

    try {
      revision = JSON.parse(decodeURIComponent(uri.query)) as Revision;
    } catch {
      return '';
    }

    if (revision.blob === null) {
      return '';
    }

    const cached = this.cache.get(revision.blob);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const raw = await this.git.runRead(revision.repo, ['cat-file', 'blob', revision.blob]);

      // A text document cannot hold binary content: it would be mangled on the way through and the
      // diff would be nonsense. Say so instead of pretending.
      const content = raw.slice(0, 8192).includes('\x00')
        ? `// Braid: this revision is a binary file (${raw.length} bytes) and has no text diff.\n`
        : raw;

      // Bound the cache: a session spent clicking through a large repository would otherwise hold
      // every blob it ever showed.
      if (this.cache.size > 256) {
        this.cache.clear();
      }

      this.cache.set(revision.blob, content);
      return content;
    } catch (err) {
      return `// Braid could not read this revision.\n// ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }
}
