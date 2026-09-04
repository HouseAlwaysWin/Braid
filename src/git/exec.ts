/**
 * Running git.
 *
 * The conventions here are lifted from GitFlick's `Services/GitService.cs`, which already paid for
 * them on Windows:
 *
 * - **Never go through a shell.** Arguments are passed as an array, so a branch called
 *   `feature/a b & c` cannot turn into two commands.
 * - **`-c core.quotepath=false`** or git octal-escapes every non-ASCII byte in a path, and
 *   CJK filenames come back as gibberish.
 * - **`-c i18n.logOutputEncoding=UTF-8`** or commit messages come back in the system codepage.
 * - **Decode from Buffers, not string chunks.** A multi-byte character straddling two chunk
 *   boundaries decodes to replacement characters if each chunk is stringified on arrival.
 * - **`--no-show-signature`** on anything that reads commits: signature verification shells out to
 *   gpg per commit and can hang for seconds.
 *
 * On top of that this adds what a scrolling UI needs: a bounded process pool, so a fast scroll
 * cannot fork fifty gits, and cancellation, so superseded queries stop burning CPU.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface GitRunOptions {
  /** Abort the process when this fires - used when the user scrolls past a pending page. */
  readonly signal?: AbortSignal;
  /** Fed to git on stdin, for the commands that read a list of paths. */
  readonly stdin?: string;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim() || '(no output)'}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** One finished git invocation, for the command log. */
export interface GitLogEntry {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly failed: boolean;
}

/** Config git is forced into for every call, so output is machine-readable and locale-proof. */
const FORCED_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=UTF-8',
  '-c',
  'log.showSignature=false',
];

/** Reads observe the repository; writes change it. They do not want the same environment. */
export type GitMode = 'read' | 'write';

/**
 * Environment a git call runs under.
 *
 * Shared by both modes: `GIT_TERMINAL_PROMPT=0`, because a prompt in the extension host is a hang
 * with no way out; and `LC_ALL=C`, which pins git's own messages to English so error matching is
 * not locale-dependent - the thing that makes `errors.ts` possible at all.
 *
 * Only reads get `GIT_OPTIONAL_LOCKS=0`. It stops a read command from writing to .git, which our
 * own watcher would otherwise see as a change; for a write, suppressing locks is meaningless at
 * best.
 *
 * Only writes get the editor overrides, and they are not optional. `git revert`, `git cherry-pick`
 * and a non-fast-forward `git merge` all open an editor for the message by default. In a terminal
 * that is a prompt; in an extension host it is a child process waiting forever on an editor that
 * will never launch, holding the repository lock while it waits. `true` is a program that exits 0
 * immediately, which is exactly the "editor" these commands need.
 */
function gitEnv(mode: GitMode): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };

  if (mode === 'read') {
    return { ...base, GIT_OPTIONAL_LOCKS: '0' };
  }

  return {
    ...base,
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
  };
}

/** git writes progress to stderr forever; nothing we run should produce more than this. */
const MAX_BUFFER = 256 * 1024 * 1024;

export class Git {
  private readonly gitPath: string;
  private readonly maxConcurrent: number;
  private readonly onCommand: ((entry: GitLogEntry) => void) | undefined;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: {
    gitPath?: string;
    maxConcurrent?: number;
    onCommand?: (entry: GitLogEntry) => void;
  } = {}) {
    this.gitPath = options.gitPath ?? 'git';
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
    this.onCommand = options.onCommand;
  }

  /** Run a command that only observes the repository, and throw if it fails. */
  async runRead(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    return this.throwOnFailure(await this.tryRead(cwd, args, options), args);
  }

  /**
   * Run a command that changes the repository.
   *
   * Separate from `runRead` so the two can never share an environment by accident - see `gitEnv`
   * for why that matters. Callers are expected to hold the repository lock; this deliberately does
   * not take it itself, because a write is usually one step of a sequence (check state, act,
   * re-read) that has to be atomic as a whole.
   */
  async runWrite(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<string> {
    const result = await this.execute(cwd, args, options, 'write');
    return this.throwOnFailure(result, args);
  }

  /** Run git and hand back the exit code instead of throwing - for the probes that expect failure. */
  async tryRead(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    return this.execute(cwd, args, options, 'read');
  }

  private throwOnFailure(result: GitResult, args: readonly string[]): string {
    if (result.exitCode !== 0) {
      throw new GitError(args, result.exitCode, result.stderr);
    }

    return result.stdout;
  }

  private async execute(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions,
    mode: GitMode,
  ): Promise<GitResult> {
    await this.acquire();
    const started = Date.now();

    try {
      const result = await this.spawn(cwd, args, options, mode);

      this.onCommand?.({
        args,
        cwd,
        durationMs: Date.now() - started,
        exitCode: result.exitCode,
        failed: result.exitCode !== 0,
      });

      return result;
    } finally {
      this.release();
    }
  }

  /**
   * Run git and hand back stdout in pieces as it arrives.
   *
   * This is what makes a big repository feel instant: `git log` on 100k commits takes seconds to
   * finish, but the first hundred rows are on stdout within milliseconds, so the graph can paint
   * while git is still walking. It also avoids the `--skip` trap - paging with `--skip=N` re-walks
   * N commits for every page, which is quadratic across a full scroll.
   *
   * Chunks are decoded with a streaming decoder, so a UTF-8 sequence split across a chunk boundary
   * still arrives as one character.
   */
  async stream(
    cwd: string,
    args: readonly string[],
    onText: (text: string) => void,
    options: GitRunOptions = {},
  ): Promise<void> {
    await this.acquire();
    const started = Date.now();

    try {
      const exitCode = await this.spawnStreaming(cwd, args, onText, options);

      this.onCommand?.({
        args,
        cwd,
        durationMs: Date.now() - started,
        exitCode,
        failed: exitCode !== 0,
      });

      if (exitCode !== 0) {
        throw new GitError(args, exitCode, '');
      }
    } finally {
      this.release();
    }
  }

  private spawnStreaming(
    cwd: string,
    args: readonly string[],
    onText: (text: string) => void,
    options: GitRunOptions,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error('cancelled'));
        return;
      }

      const child = spawn(this.gitPath, [...FORCED_CONFIG, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        // Streaming is only ever used to walk history, so it is a read by construction.
        env: gitEnv('read'),
      });

      const decoder = new StringDecoder('utf8');
      let settled = false;

      const onAbort = (): void => {
        if (!settled) {
          child.kill();
        }
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => onText(decoder.write(chunk)));
      child.stderr.resume();
      child.on('error', (err) => finish(() => reject(err)));

      child.on('close', (code, signal) => {
        finish(() => {
          const tail = decoder.end();
          if (tail.length > 0) {
            onText(tail);
          }

          if (options.signal?.aborted === true) {
            reject(new Error('cancelled'));
            return;
          }

          resolve(code ?? (signal !== null ? 128 : 1));
        });
      });

      child.stdin.end();
    });
  }

  private spawn(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions,
    mode: GitMode,
  ): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error('cancelled'));
        return;
      }

      const child = spawn(this.gitPath, [...FORCED_CONFIG, ...args], {
        cwd,
        // No shell: arguments reach git exactly as written, whatever they contain.
        shell: false,
        windowsHide: true,
        env: gitEnv(mode),
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutLength = 0;
      let settled = false;

      const onAbort = (): void => {
        if (!settled) {
          child.kill();
        }
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLength += chunk.length;
        if (stdoutLength > MAX_BUFFER) {
          child.kill();
          finish(() => reject(new Error(`git ${args[0]} produced more than ${MAX_BUFFER} bytes`)));
          return;
        }

        stdout.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => finish(() => reject(err)));

      child.on('close', (code, signal) => {
        finish(() => {
          if (options.signal?.aborted === true) {
            reject(new Error('cancelled'));
            return;
          }

          resolve({
            // Decode once, from the whole buffer: a UTF-8 sequence split across chunks survives.
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: code ?? (signal !== null ? 128 : 1),
          });
        });
      });

      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin, 'utf8');
      } else {
        child.stdin.end();
      }
    });
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
