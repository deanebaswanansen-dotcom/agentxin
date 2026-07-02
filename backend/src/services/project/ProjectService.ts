/**
 * Project domain service (design: "Services (领域层)" > ProjectService).
 *
 * Encapsulates the business rules for project management on top of the
 * persistence-agnostic {@link DataStore}:
 *
 * - create: reject empty / whitespace-only names with `VALIDATION_ERROR`
 *   (Requirement 1.5); otherwise persist and return the new project
 *   (Requirement 1.1).
 * - list: return id + name for all projects (Requirement 1.2).
 * - rename: reject unknown ids with `NOT_FOUND` (Requirement 1.6) and empty
 *   names with `VALIDATION_ERROR`; otherwise persist the new name
 *   (Requirement 1.4).
 * - remove: reject unknown ids with `NOT_FOUND` (Requirement 1.6); otherwise
 *   delete the project — the store cascades to chapters/characters/world
 *   settings/outlines (Requirement 1.3).
 *
 * Validation and existence checks raise a {@link ServiceError} so the transport
 * layer can map them to the unified API error response.
 */
import type { DataStore } from '../../store/DataStore.js';
import type { Id, Project } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';

export class ProjectService {
  constructor(private readonly store: DataStore) {}

  /**
   * Create a project (Requirement 1.1). The name must contain at least one
   * non-whitespace character; otherwise a `VALIDATION_ERROR` is thrown
   * (Requirement 1.5).
   */
  async create(name: string): Promise<Project> {
    assertNonEmptyName(name);
    // Persist the name exactly as provided (Requirement 1.1); validation only
    // rejects empty/whitespace-only names, it does not mutate a valid name.
    return this.store.createProject(name);
  }

  /** List all projects' id + name (Requirement 1.2). */
  async list(): Promise<Pick<Project, 'id' | 'name'>[]> {
    return this.store.listProjects();
  }

  /**
   * Rename a project (Requirement 1.4). Throws `NOT_FOUND` when the id does not
   * exist (Requirement 1.6) and `VALIDATION_ERROR` when the new name is empty
   * or whitespace-only (consistent with {@link create}).
   */
  async rename(id: Id, name: string): Promise<Project> {
    await this.assertExists(id);
    assertNonEmptyName(name);
    // Persist the name exactly as provided (Requirement 1.4).
    return this.store.renameProject(id, name);
  }

  /**
   * Delete a project and its associated entities (Requirement 1.3). Throws
   * `NOT_FOUND` when the id does not exist (Requirement 1.6). The cascade is
   * handled by the {@link DataStore} implementation.
   */
  async remove(id: Id): Promise<void> {
    await this.assertExists(id);
    await this.store.deleteProject(id);
  }

  /** Throw `NOT_FOUND` when no project exists for `id` (Requirement 1.6). */
  private async assertExists(id: Id): Promise<void> {
    const existing = await this.store.getProject(id);
    if (existing === undefined) {
      throw ServiceError.notFound(`项目不存在: ${id}`);
    }
  }
}

/**
 * Validate that a name has at least one non-whitespace character. Throws
 * `VALIDATION_ERROR` when the name is empty or whitespace-only (Requirement
 * 1.5); a whitespace-only name is treated as empty. The caller persists the
 * original (un-trimmed) name so the stored value round-trips exactly.
 */
function assertNonEmptyName(name: string): void {
  if (name.trim().length === 0) {
    throw ServiceError.validation('项目名称不能为空');
  }
}
