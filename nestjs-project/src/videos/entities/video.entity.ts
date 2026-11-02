import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * The status cycle the phase is graded on: `rascunho → processando → pronto/erro`
 * (per phase-03-videos/TD-11).
 *
 * Publication is deliberately NOT a value here. Phase 04's `visibility` /
 * `published_at` is an orthogonal axis and gets its own columns — folding it into
 * this enum would conflate "has the file been processed" with "has the owner
 * published it" and force an enum migration later.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Public identifier used in URLs. `nanoid(11)` generated in application code, not
   * as a DB default, so it is available in the draft-creation response. Unguessable
   * by design — Phase 05 requires unlisted videos to be reachable only by direct
   * link (per phase-03-videos/TD-13).
   */
  @Column({ type: 'varchar', length: 11, unique: true })
  slug: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  // --- storage keys: two buckets per phase-03-videos/TD-05 (Option B) ---

  @Column({ type: 'varchar', length: 63 })
  video_bucket: string;

  @Column({ type: 'varchar', length: 1024 })
  video_key: string;

  @Column({ type: 'varchar', length: 63, nullable: true })
  thumbnail_bucket: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  thumbnail_key: string | null;

  /** S3 multipart UploadId, retained so a resume can call `ListParts`. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /**
   * Size the client declared at draft creation. The comparand for the completion
   * integrity check — NOT a policy limit. No upload ceiling exists in this phase
   * (per phase-03-videos/TD-04; TD-06 was rejected as an invented requirement).
   */
  @Column({ type: 'bigint' })
  declared_size_bytes: string;

  @Column({ type: 'varchar', length: 255 })
  content_type: string;

  // --- metadata extracted by the worker; all nullable by design, because a field
  //     absent from the ffprobe output must persist as NULL rather than fail the
  //     job (per phase-03-videos/TD-09) ---

  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  codec_name: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  container_format: string | null;

  @Column({ type: 'bigint', nullable: true })
  bitrate_bps: string | null;

  /** Actual size observed by ffprobe — distinct from `declared_size_bytes`. */
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  // --- failure handling (per phase-03-videos/TD-11) ---

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'integer', default: 0 })
  processing_attempts: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
