import type { Env } from './env';
import { AppError, validateFile, type DesignFile } from './model';
export class Store {
  constructor(private env: Env) {}
  async list() {
    return (
      await this.env.DB.prepare(
        'SELECT id, name, version, updated_at FROM files ORDER BY updated_at DESC',
      ).all()
    ).results;
  }
  async get(id: string): Promise<{ file: DesignFile; version: number }> {
    const row = await this.env.DB.prepare('SELECT body, version FROM files WHERE id = ?')
      .bind(id)
      .first<{ body: string; version: number }>();
    if (!row) throw new AppError(404, 'File not found');
    return { file: JSON.parse(row.body), version: row.version };
  }
  async create(file: DesignFile) {
    validateFile(file);
    await this.env.DB.prepare('INSERT INTO files(id, name, body) VALUES (?, ?, ?)')
      .bind(file.id, file.name, JSON.stringify(file))
      .run();
    return { file, version: 1 };
  }
  async mutate(id: string, change: (file: DesignFile) => void, expectedVersion?: number) {
    const { file, version } = await this.get(id);
    if (expectedVersion !== undefined && version !== expectedVersion)
      throw new AppError(409, 'Version conflict; read file and retry');
    change(file);
    validateFile(file);
    const result = await this.env.DB.prepare(
      "UPDATE files SET body = ?, name = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND version = ?",
    )
      .bind(JSON.stringify(file), file.name, id, version)
      .run();
    if (!result.meta.changes) throw new AppError(409, 'Concurrent change; read file and retry');
    return { file, version: version + 1 };
  }
  async revisions(id: string) {
    await this.get(id);
    return (
      await this.env.DB.prepare(
        'SELECT version, created_at FROM revisions WHERE file_id = ? ORDER BY version DESC',
      )
        .bind(id)
        .all()
    ).results;
  }
  async restore(id: string, revision: number, expectedVersion: number) {
    const row = await this.env.DB.prepare(
      'SELECT body FROM revisions WHERE file_id = ? AND version = ?',
    )
      .bind(id, revision)
      .first<{ body: string }>();
    if (!row) throw new AppError(404, 'Revision not found');
    return this.mutate(id, (file) => Object.assign(file, JSON.parse(row.body)), expectedVersion);
  }
}
