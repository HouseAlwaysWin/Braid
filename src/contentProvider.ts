/**
 * Serves file contents at a revision, so VS Code's own diff editor can show them.
 *
 * Two details decide whether this works:
 *
 * - **The URI path must end with the real filename.** VS Code picks the language mode - and
 *   therefore the syntax highlighting in the diff - from the path's extension. A URI of
 *   `weft-git:/abc123` opens every diff as plain text.
 * - **Content is addressed by blob OID, not by `<commit>:<path>`.** A renamed file has a different
 *   path on each side, so path addressing needs rename resolution that the raw diff already did
 *   for us.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';

export const SCHEME = 'weft-git';

interface Revision {
  readonly repo: string;
  /** null renders as an empty document - the missing side of an add or a delete. */
  readonly blob: string | null;
  /**
   * A revision to read the path from instead, for the one case where no blob OID is to hand: the
   * left side of an uncommitted change. `git status` does not report OIDs, and asking for one per
   * file would be a process per row - `HEAD:<path>` costs nothing extra and says the same thing.
   */
  readonly at?: string;
}

/**
 * Build a URI for one side of a diff. `path` is only ever used for the filename and language mode;
 * the content comes from `blob`.
 */
export function revisionUri(repo: string, path: string, blob: string | null, label: string): vscode.Uri {
  return buildUri({ repo, blob }, path, label);
}

/**
 * The same, addressed by revision and path rather than by blob OID.
 *
 * Rename resolution is what blob addressing buys, and an uncommitted change has no rename to
 * resolve: git has not been told about it yet.
 */
export function pathAtUri(repo: string, path: string, at: string, label: string): vscode.Uri {
  return buildUri({ repo, blob: null, at }, path, label);
}

function buildUri(query: Revision, path: string, label: string): vscode.Uri {

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

    if (revision.blob === null && revision.at === undefined) {
      return '';
    }

    /*
     * The cache key is the thing being read. A blob OID is immutable, so caching it is free; a
     * `HEAD:<path>` is not - HEAD moves - so it is read afresh every time and never stored.
     */
    const cached = revision.blob === null ? undefined : this.cache.get(revision.blob);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const args =
        revision.blob === null
          ? ['show', `${revision.at ?? 'HEAD'}:${uri.path.replace(/^\//, '')}`]
          : ['cat-file', 'blob', revision.blob];

      const raw = await this.git.runRead(revision.repo, args);

      // A text document cannot hold binary content: it would be mangled on the way through and the
      // diff would be nonsense. Say so instead of pretending.
      const content = raw.slice(0, 8192).includes('\x00')
        ? `// Weft: this revision is a binary file (${raw.length} bytes) and has no text diff.\n`
        : raw;

      // Bound the cache: a session spent clicking through a large repository would otherwise hold
      // every blob it ever showed.
      if (this.cache.size > 256) {
        this.cache.clear();
      }

      if (revision.blob !== null) {
        this.cache.set(revision.blob, content);
      }

      return content;
    } catch (err) {
      return `// Weft could not read this revision.\n// ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }
}
