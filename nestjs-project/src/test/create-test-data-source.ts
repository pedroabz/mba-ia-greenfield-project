import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

/**
 * Every entity in the schema, in one place.
 *
 * TypeORM resolves the inverse side of each relation at initialization, so a
 * DataSource built from a PARTIAL list fails outright — adding
 * `@OneToMany(() => Video)` to `Channel` broke every suite whose hand-rolled array
 * omitted `Video`, with "Entity metadata for Channel#videos was not found". Suites
 * import this constant so a new entity is a one-line change here, not a hunt
 * through a dozen files.
 */
export const ALL_ENTITIES = [
  User,
  Channel,
  Video,
  RefreshToken,
  VerificationToken,
];

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

/** What TypeORM accepts in `entities`, without the bare `Function` type. */
type EntityInput =
  | (new (...args: never[]) => object)
  | string
  | EntitySchema<unknown>;

export function createTestDataSource(
  entities: EntityInput[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
