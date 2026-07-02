import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * Workspace helpers for .agentxin/workspace.json (shared between CLI and API proxy layer).
 * Per spec: automatic project dir inference, relative paths.
 */

interface WorkspaceState {
  currentProject?: string;
}

const WORKSPACE_FILE = '.agentxin/workspace.json';

function workspaceFile(cwd: string): string {
  return resolve(cwd, WORKSPACE_FILE);
}

async function readWorkspace(cwd: string): Promise<WorkspaceState> {
  const file = workspaceFile(cwd);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as WorkspaceState;
    return typeof parsed.currentProject === 'string' ? parsed : {};
  } catch {
    return {};
  }
}

export async function getCurrentProject(cwd: string): Promise<string | undefined> {
  return (await readWorkspace(cwd)).currentProject;
}

export async function setCurrentProject(cwd: string, projectPath: string): Promise<string> {
  const resolved = resolve(cwd, projectPath);
  const state: WorkspaceState = { currentProject: relative(cwd, resolved).replace(/\\/g, '/') };
  const file = workspaceFile(cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return resolved;
}

export async function clearCurrentProject(cwd: string): Promise<void> {
  await rm(workspaceFile(cwd), { force: true });
}

/** Infer effective project dir for Python agent calls. Prefers explicit, falls back to workspace or cwd. Returns relative preferred. */
export async function inferProjectDir(explicit?: string, cwd = process.cwd()): Promise<string> {
  if (explicit && explicit.trim()) {
    return relative(cwd, resolve(cwd, explicit)).replace(/\\/g, '/');
  }
  const current = await getCurrentProject(cwd);
  if (current) {
    return current;
  }
  // Default demo if nothing
  return 'projects/demo-novel';
}

