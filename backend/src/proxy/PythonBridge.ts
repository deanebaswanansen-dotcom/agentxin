/**
 * PythonBridge: thin subprocess caller to Python LangGraph Agent (web_bridge.py).
 *
 * Per refactoring spec: Node backend is thin API/web layer.
 * Python is the single source of truth LangGraph core engine.
 *
 * - Invokes via `python -u src/novel_agent/web_bridge.py` (stdin/stdout JSON).
 * - Passes task, prompt, projectDir (relative preferred), chapterId, sceneId etc.
 * - Returns structured: blueprint, sceneContents, chapterContent, reports.
 * - Always normalizes to relative paths.
 * - Explicit provider: fails fast if no config (no silent mock in bridge unless allowed).
 * - Supports future streaming: for now full result + Node emits synthetic progress.
 */

import { spawn } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inferProjectDir } from '../cli/workspace.js';
import type {
  ChapterBlueprint,
  PacingReport,
  WordCountReport,
} from '../types/index.js';
import { ServiceError } from '../services/ServiceError.js';

export interface PythonBridgePayload {
  task: string;
  prompt?: string;
  projectDir?: string;
  chapterId?: string;
  sceneId?: string;
  addWords?: number;
  instruction?: string;
}

export interface PythonBridgeResult {
  ok: boolean;
  task: string;
  summary: string;
  chapterId: string;
  projectDir: string; // relative
  blueprint?: ChapterBlueprint | null;
  sceneContents?: Record<string, string>;
  chapterContent?: string;
  reports?: {
    word_count?: WordCountReport | null;
    pacing?: PacingReport | null;
  };
  toolResults?: Array<{ tool: string; ok?: boolean; path?: string; [k: string]: unknown }>;
  result?: unknown;
}

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(moduleDir, '../../..'); // backend -> project root

function toRelative(p: string): string {
  try {
    const rel = relative(ROOT, resolve(ROOT, p)).replace(/\\/g, '/');
    return rel.startsWith('..') ? p.replace(/\\/g, '/') : rel;
  } catch {
    return p.replace(/\\/g, '/');
  }
}

export class PythonBridge {
  /**
   * Call Python web_bridge with JSON over stdin.
   * Timeout default 5min for long agent writes.
   */
  async call(payload: PythonBridgePayload, timeoutMs = 300000): Promise<PythonBridgeResult> {
    const inferred = await inferProjectDir(payload.projectDir);
    const projectDir = toRelative(inferred);

    const fullPayload = {
      ...payload,
      projectDir,
    };

    // Determine python cmd: allow override via env, default python (Windows py/python)
    const pythonCmd = process.env.PYTHON || process.env.PYTHON3 || 'python';

    return new Promise((resolvePromise, reject) => {
      const proc = spawn(pythonCmd, ['-u', 'src/novel_agent/web_bridge.py'], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(ServiceError.validation(`Python agent timeout after ${timeoutMs}ms for task=${payload.task}`));
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(ServiceError.validation(`Failed to spawn Python bridge (${pythonCmd}): ${err.message}. Ensure Python env and novel-agent deps installed.`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const msg = `Python bridge exited ${code}. stderr: ${stderr.slice(0, 500)}`;
          reject(ServiceError.validation(msg));
          return;
        }
        try {
          // last JSON line (in case of prints)
          const lines = stdout.trim().split(/\r?\n/);
          const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{')) || stdout;
          const parsed = JSON.parse(jsonLine) as PythonBridgeResult;
          // Normalize paths again
          if (parsed.projectDir) parsed.projectDir = toRelative(parsed.projectDir);
          resolvePromise(parsed);
        } catch (e: any) {
          reject(ServiceError.validation(`Python bridge invalid JSON output: ${e.message}. stdout head: ${stdout.slice(0, 300)}`));
        }
      });

      // Write JSON to stdin
      proc.stdin.write(JSON.stringify(fullPayload) + '\n');
      proc.stdin.end();
    });
  }
}

export const pythonBridge = new PythonBridge();
