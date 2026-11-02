import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DataSource, LessThan } from 'typeorm';
import { DRAFT_EXPIRY_HOURS, QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

export interface ReapSummary {
  draftsDeleted: number;
  uploadsAborted: number;
}

/**
 * Removes the debris of uploads that were started and never finished.
 *
 * This job carries the cleanup requirement that was originally meant to be a bucket
 * lifecycle rule. **The MinIO build in use rejects `AbortIncompleteMultipartUpload`
 * in every Filter shape, and silently drops the clause when it is paired with an
 * Expiration action** — verified against both `mc` and `aws-cli` (see
 * nestjs-project/CLAUDE.md § Video Infrastructure). `ListMultipartUploads` +
 * `AbortMultipartUpload` are both fully supported, so the work moves here.
 *
 * Naturally idempotent: it operates on a status-and-age predicate, not on a fixed
 * row set, so a duplicate delivery simply finds nothing left to do.
 */
@Injectable()
export class DraftReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DraftReaperService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.registerWorker(QUEUES.DRAFT_REAPER, async () => {
      await this.reap();
    });
    this.logger.log(`Worker registered on "${QUEUES.DRAFT_REAPER}"`);
  }

  async reap(expiryHours: number = DRAFT_EXPIRY_HOURS): Promise<ReapSummary> {
    const cutoff = new Date(Date.now() - expiryHours * 60 * 60 * 1000);

    // Only `draft` rows. A `processing` row of the same age is a job in flight and a
    // `ready` row is a published video — neither is debris.
    const deletion = await this.dataSource.getRepository(Video).delete({
      status: VideoStatus.DRAFT,
      created_at: LessThan(cutoff),
    });

    const stale = await this.storage.listStaleUploads(
      this.storage.bucketVideos,
      cutoff,
    );
    for (const upload of stale) {
      await this.storage.abortUpload(
        this.storage.bucketVideos,
        upload.key,
        upload.uploadId,
      );
    }

    const summary: ReapSummary = {
      draftsDeleted: deletion.affected ?? 0,
      uploadsAborted: stale.length,
    };

    if (summary.draftsDeleted > 0 || summary.uploadsAborted > 0) {
      this.logger.log(
        `Reaped ${summary.draftsDeleted} stale draft(s) and aborted ${summary.uploadsAborted} orphan upload(s)`,
      );
    }

    return summary;
  }
}
