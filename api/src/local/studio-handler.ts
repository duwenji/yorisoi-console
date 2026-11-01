import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, NotFound, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { StartTranscriptionJobCommand, TranscribeClient } from '@aws-sdk/client-transcribe';
import { bedrockCheck, documentClient, emitMetric, env, settingsLoader } from './aws.js';
import { finishTranscription, goLive, startCheck, type StudioPorts } from './studio.js';

/**
 * The studio check's Lambda (DES-013 K-11). It is started three ways:
 * - `{ "check": id }` by the console when a provider puts a studio up,
 * - `{ "publish": id }` by the console when the operator accepts an appeal,
 * - a "Transcribe Job State Change" event for this stack's jobs.
 */
export type StudioEvent =
  | { check: string }
  | { publish: string }
  | { source: 'aws.transcribe'; detail: { TranscriptionJobName: string; TranscriptionJobStatus: string } };

let cached: StudioPorts | undefined;

function build(): StudioPorts {
  const region = env('AWS_REGION');
  const s3 = new S3Client({ region });
  const transcribe = new TranscribeClient({ region });
  const intake = env('INTAKE_BUCKET');
  const missing = (e: unknown) => e instanceof NoSuchKey || e instanceof NotFound || (e as { name?: string })?.name === 'NotFound';
  return {
    db: documentClient(),
    table: env('TABLE_NAME'),
    relayTable: env('RELAY_TABLE_NAME'),
    now: () => new Date(),
    settings: settingsLoader(),
    check: bedrockCheck(),
    intake: {
      head: async (key) => {
        try {
          return { bytes: (await s3.send(new HeadObjectCommand({ Bucket: intake, Key: key }))).ContentLength ?? 0 };
        } catch (e) {
          if (missing(e)) return undefined;
          throw e;
        }
      },
      read: async (key) => new Uint8Array(await (await s3.send(new GetObjectCommand({ Bucket: intake, Key: key }))).Body!.transformToByteArray()),
      copy: async (from, to) => {
        await s3.send(new CopyObjectCommand({ Bucket: intake, Key: to, CopySource: `${intake}/${from}` }));
      },
      text: async (key) => {
        try {
          return await (await s3.send(new GetObjectCommand({ Bucket: intake, Key: key }))).Body!.transformToString('utf-8');
        } catch (e) {
          if (missing(e)) return undefined;
          throw e;
        }
      },
    },
    serveAudio: async (from, to) => {
      // The id is in the key, so the object never changes: cached for as long as it lives.
      await s3.send(
        new CopyObjectCommand({
          Bucket: env('AUDIO_BUCKET'), Key: to, CopySource: `${intake}/${from}`,
          MetadataDirective: 'REPLACE', ContentType: 'audio/mp4', CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
    transcribe: async (jobName, mediaKey, outputKey) => {
      await transcribe.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: 'ja-JP',
          MediaFormat: 'mp4',
          Media: { MediaFileUri: `s3://${intake}/${mediaKey}` },
          OutputBucketName: intake,
          OutputKey: outputKey,
        }),
      );
    },
    jobPrefix: env('JOB_PREFIX'),
    metric: emitMetric,
  };
}

export async function handler(event: StudioEvent): Promise<void> {
  cached ??= build();
  if ('check' in event) return startCheck(cached, event.check);
  if ('publish' in event) return goLive(cached, event.publish, 'appealed');
  if (event.source === 'aws.transcribe') return finishTranscription(cached, event.detail.TranscriptionJobName, event.detail.TranscriptionJobStatus);
}
