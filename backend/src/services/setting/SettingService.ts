/**
 * SettingService — 结构化设定（人物 / 世界观 / 大纲）领域逻辑（task 5.1）。
 *
 * 该服务在 {@link DataStore} 之上实现需求 3 的业务规则，向传输层（路由）暴露三类
 * 设定条目的创建、列表、更新与删除能力。为与前端 `apiClient.settings`
 * （`characters` / `worldSettings` / `outlines`）以及设定路由（task 11.3）的命名保持一致，
 * 这里以三个子命名空间暴露各自的 CRUD 方法：
 *
 *   service.characters.{create,list,update,remove}
 *   service.worldSettings.{create,list,update,remove}
 *   service.outlines.{create,list,update,remove}
 *
 * 依赖注入：构造函数接收一个 {@link DataStore} 实现，便于在测试中替换为内存/文件实现。
 *
 * 错误处理（需求 3.7 / 设计「Error Handling」/ Property 5）：
 * - 对不存在的条目标识符执行 `update` 或 `remove` 时，抛出 {@link ServiceError}
 *   （code `NOT_FOUND`），由路由层映射为 HTTP 404。
 * - {@link DataStore} 的 `update*` 对缺失 id 抛出的是普通 `Error`（前置条件违例），
 *   而 `delete*` 对缺失 id 是幂等无操作；二者都无法直接产生符合规范的 `NOT_FOUND`。
 *   因此本服务在变更前先校验存在性：使用现有的 `list*` 方法跨项目查找该 id
 *   （DataStore 未提供按 id 的单条 getter），命中则委托存储执行，未命中则抛出 `NOT_FOUND`。
 *
 * 校验范围（刻意从简）：需求 3.1–3.7 未对人物姓名 / 世界观或大纲标题施加「非空」约束
 * （对比需求 1.5 项目名非空、需求 4.4 模型配置字段非空），且正确性属性 11/12 要求对
 * 「任意字段值」均能创建并往返。故本服务不对字段内容做非空校验，唯一的领域错误为
 * `NOT_FOUND`。存储按所给值原样保存。
 */
import type { DataStore } from '../../store/DataStore.js';
import type { Character, Id, Outline, WorldSetting } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';

/** 人物条目子命名空间接口。 */
export interface CharacterApi {
  /** 在项目下创建人物条目（需求 3.1）。 */
  create(projectId: Id, name: string, description: string): Promise<Character>;
  /** 返回项目下的全部人物条目（需求 3.4）。 */
  list(projectId: Id): Promise<Character[]>;
  /** 更新人物条目字段；id 不存在时抛出 `NOT_FOUND`（需求 3.5、3.7）。 */
  update(
    id: Id,
    fields: Partial<Pick<Character, 'name' | 'description'>>,
  ): Promise<Character>;
  /** 删除人物条目；id 不存在时抛出 `NOT_FOUND`（需求 3.6、3.7）。 */
  remove(id: Id): Promise<void>;
}

/** 世界观条目子命名空间接口。 */
export interface WorldSettingApi {
  /** 在项目下创建世界观条目（需求 3.2）。 */
  create(projectId: Id, title: string, content: string): Promise<WorldSetting>;
  /** 返回项目下的全部世界观条目（需求 3.4）。 */
  list(projectId: Id): Promise<WorldSetting[]>;
  /** 更新世界观条目字段；id 不存在时抛出 `NOT_FOUND`（需求 3.5、3.7）。 */
  update(
    id: Id,
    fields: Partial<Pick<WorldSetting, 'title' | 'content'>>,
  ): Promise<WorldSetting>;
  /** 删除世界观条目；id 不存在时抛出 `NOT_FOUND`（需求 3.6、3.7）。 */
  remove(id: Id): Promise<void>;
}

/** 大纲条目子命名空间接口。 */
export interface OutlineApi {
  /** 在项目下创建大纲条目（需求 3.3）。 */
  create(projectId: Id, title: string, content: string): Promise<Outline>;
  /** 返回项目下的全部大纲条目（按 position 升序，需求 3.4）。 */
  list(projectId: Id): Promise<Outline[]>;
  /** 更新大纲条目字段；id 不存在时抛出 `NOT_FOUND`（需求 3.5、3.7）。 */
  update(
    id: Id,
    fields: Partial<Pick<Outline, 'title' | 'content'>>,
  ): Promise<Outline>;
  /** 删除大纲条目；id 不存在时抛出 `NOT_FOUND`（需求 3.6、3.7）。 */
  remove(id: Id): Promise<void>;
}

export class SettingService {
  /** 人物条目操作（需求 3.1、3.4、3.5、3.6）。 */
  readonly characters: CharacterApi;
  /** 世界观条目操作（需求 3.2、3.4、3.5、3.6）。 */
  readonly worldSettings: WorldSettingApi;
  /** 大纲条目操作（需求 3.3、3.4、3.5、3.6）。 */
  readonly outlines: OutlineApi;

  constructor(private readonly store: DataStore) {
    this.characters = {
      create: (projectId, name, description) =>
        this.store.createCharacter(projectId, name, description),
      list: (projectId) => this.store.listCharacters(projectId),
      update: async (id, fields) => {
        await this.assertExists(
          (projectId) => this.store.listCharacters(projectId),
          id,
          '人物条目',
        );
        return this.store.updateCharacter(id, fields);
      },
      remove: async (id) => {
        await this.assertExists(
          (projectId) => this.store.listCharacters(projectId),
          id,
          '人物条目',
        );
        return this.store.deleteCharacter(id);
      },
    };

    this.worldSettings = {
      create: (projectId, title, content) =>
        this.store.createWorldSetting(projectId, title, content),
      list: (projectId) => this.store.listWorldSettings(projectId),
      update: async (id, fields) => {
        await this.assertExists(
          (projectId) => this.store.listWorldSettings(projectId),
          id,
          '世界观条目',
        );
        return this.store.updateWorldSetting(id, fields);
      },
      remove: async (id) => {
        await this.assertExists(
          (projectId) => this.store.listWorldSettings(projectId),
          id,
          '世界观条目',
        );
        return this.store.deleteWorldSetting(id);
      },
    };

    this.outlines = {
      create: (projectId, title, content) =>
        this.store.createOutline(projectId, title, content),
      list: (projectId) => this.store.listOutlines(projectId),
      update: async (id, fields) => {
        await this.assertExists(
          (projectId) => this.store.listOutlines(projectId),
          id,
          '大纲条目',
        );
        return this.store.updateOutline(id, fields);
      },
      remove: async (id) => {
        await this.assertExists(
          (projectId) => this.store.listOutlines(projectId),
          id,
          '大纲条目',
        );
        return this.store.deleteOutline(id);
      },
    };
  }

  /**
   * 跨全部项目按 id 查找某类型的设定条目。{@link DataStore} 未提供按 id 的单条
   * getter，且 `list*` 以 projectId 作用域，因此遍历所有项目逐一查找。命中返回该条目，
   * 否则返回 `undefined`。
   */
  private async findById<T extends { id: Id }>(
    list: (projectId: Id) => Promise<T[]>,
    id: Id,
  ): Promise<T | undefined> {
    const projects = await this.store.listProjects();
    for (const { id: projectId } of projects) {
      const items = await list(projectId);
      const found = items.find((item) => item.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * 在变更前校验某类型设定条目存在；不存在时抛出 `NOT_FOUND`（需求 3.7）。
   * `label` 用于构造面向用户的错误信息（如「人物条目」）。
   */
  private async assertExists<T extends { id: Id }>(
    list: (projectId: Id) => Promise<T[]>,
    id: Id,
    label: string,
  ): Promise<void> {
    const found = await this.findById(list, id);
    if (!found) {
      throw ServiceError.notFound(`${label}不存在：${id}`);
    }
  }
}
