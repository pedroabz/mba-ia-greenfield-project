import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ALL_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ChannelsModule } from './channels.module';

describe('ChannelsModule', () => {
  it('should compile with TypeOrmModule.forFeature([Channel]) and ChannelsService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        ChannelsModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
