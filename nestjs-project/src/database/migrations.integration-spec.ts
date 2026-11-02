import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793565420912 } from './migrations/1793565420912-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1793565420912,
        ],
      },
    );

    await dataSource.initialize();

    // Strictly SEQUENTIAL. `DROP TABLE ... CASCADE` takes an AccessExclusive lock on
    // the target AND on every table referencing it, so issuing these concurrently
    // over a pool makes two drops each wait on a lock the other already holds —
    // a deadlock that hangs the suite instead of failing it.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // Dropping a table does NOT drop the enum types its columns used, and a leftover
    // type makes the migration's CREATE TYPE fail. Enumerate them instead of listing
    // them by name, so a crashed run cannot leave behind a type this never cleans.
    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT t.typname FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typtype = 'e' AND n.nspname = 'public'`,
    );
    for (const { typname } of enums) {
      await dataSource.query(`DROP TYPE IF EXISTS "${typname}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
  });

  it('should leave the previous migrations intact after the revert', async () => {
    // "Leaves the schema in the PRIOR state" is the actual requirement — asserting
    // only that `videos` is gone would also pass if the revert had dropped the
    // phase-02 tables with it.
    const survivors = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [['users', 'channels', 'refresh_tokens', 'verification_tokens']],
    );

    expect(survivors.map((r) => r.table_name)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);

    // And exactly the two earlier migrations remain recorded as applied.
    const applied = await dataSource.query<{ name: string }[]>(
      `SELECT name FROM migrations ORDER BY timestamp`,
    );
    expect(applied.map((r) => r.name)).toEqual([
      'CreateUsersAndChannels1775687773260',
      'CreateAuthTokens1777579850478',
    ]);
  });

  it('should drop the status enum type when the videos migration is reverted', async () => {
    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(types).toHaveLength(0);
  });
});
