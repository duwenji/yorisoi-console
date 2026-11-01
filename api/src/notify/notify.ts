import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { auditItem, type Notice } from '../console/deps.js';

/**
 * Emails the publisher what happened (ADR-001 A-19, API-001 C-14, DES-006). The console API queues
 * a notice after its change; this sends it once, to the publisher's Cognito-verified address, and
 * records the outcome in the audit log (without the address).
 */

export interface Mail {
  to: string;
  subject: string;
  body: string;
}

export interface NotifyPorts {
  db: DynamoDBDocumentClient;
  table: string;
  now: () => Date;
  /** The console's address, for the link in the mail. */
  consoleUrl: string;
  /** The verified email of a Cognito user, or undefined. */
  emailOf: (sub: string) => Promise<string | undefined>;
  /** Sends the mail and returns the message id. In development it only logs (no domain yet, T-7). */
  send: (mail: Mail) => Promise<string>;
}

const SYSTEM = { sub: 'notifier', roles: [] };
/** How long a sent notice is remembered, to drop a redelivered message (SQS may deliver twice). */
const REMEMBER_DAYS = 30;

const FOOTER = '\n\n—\nSanpoGuide チャンネル管理システム\nこのメールは送信専用です。返信はできません。';

export function render(notice: Notice, consoleUrl: string): { subject: string; body: string } {
  const channel = notice.channelId ? `チャンネル ${notice.channelId} ` : notice.collectionId ? `素材集 ${notice.collectionId} ` : '';
  const used = notice.collectionId ? `素材集 ${notice.collectionId} ` : '';
  const what = notice.version !== undefined ? `${channel}の版 ${notice.version} ` : channel;
  const link = notice.channelId ? `${consoleUrl}/channels/${notice.channelId}` : notice.collectionId ? `${consoleUrl}/collections/${notice.collectionId}` : notice.event.startsWith('studio.') || notice.placementId ? `${consoleUrl}/studio` : `${consoleUrl}/`;
  const message = notice.message ? `\n\n運営からのメッセージ:\n${notice.message}` : '';
  const findings = notice.findings?.length ? `\n\n指摘（審査基準の項目）:\n${notice.findings.map((f) => `・${f.item}: ${f.detail}`).join('\n')}` : '';
  const lines = ((): [string, string] => {
    switch (notice.event) {
      case 'submission.approved':
        return [`${what}を承認しました`, `${what}を承認しました。数分のうちに公開のリストに載ります。${message}`];
      case 'submission.returned':
        return [`${what}を差し戻しました`, `${what}を差し戻しました。指摘を直して、もう一度申請してください。${findings}${message}`];
      case 'submission.rejected':
        return [`${what}を却下しました`, `${what}を却下しました。${findings}${message}`];
      case 'channel.revoked':
        return [`${channel}を取り下げました`, `運営が${channel}を公開のリストから取り下げました。${message}`];
      case 'transfer.approved':
        return [
          '鍵の移し替えを承認しました',
          `鍵の移し替えを承認しました。これからの申請は新しい鍵で署名してください。${notice.returned ? `\n古い鍵で署名した審査待ちの申請 ${notice.returned} 件を差し戻しました。` : ''}`,
        ];
      case 'collection.approved':
        return [`${what}を承認しました`, `${what}を承認しました。数分のうちに公開のリストに載り、チャンネルから使えるようになります。${message}`];
      case 'collection.returned':
        return [`${what}を差し戻しました`, `${what}を差し戻しました。指摘を直して、もう一度申請してください。${findings}${message}`];
      case 'collection.rejected':
        return [`${what}を却下しました`, `${what}を却下しました。${findings}${message}`];
      case 'collection.revoked':
        return [`${channel}を取り下げました`, `運営が${channel}を公開のリストから取り下げました。この素材集を使うチャンネルでは、その素材が出なくなります。${message}`];
      case 'collection.external_failed':
        return [
          `${channel}の外部の素材に取得できないものがあります`,
          `毎日の確認で、${channel}の外部の素材のうち、次のものを取得できませんでした。置き場所を確かめてください。直らないあいだ、その素材は出ません。\n\n${notice.message ?? ''}`,
        ];
      case 'collection.updated':
        return [
          `${channel}が使う${used}が更新されました`,
          `${channel}が使う${used}の新しい版${notice.version !== undefined ? ` ${notice.version}` : ''}が承認されました。参照している素材は残っています。中身が変わっていないか、画面で確かめてください。${message}`,
        ];
      case 'collection.revoked_used':
        return [`${channel}が使う${used}が取り下げられました`, `${channel}が使う${used}が公開のリストから取り下げられました。その素材は出なくなり、次の候補（AI の解説など）に代わります。${message}`];
      case 'collection.grants_narrowed':
        return [`${channel}は${used}を使えなくなりました`, `${used}の利用許諾が変わり、${channel}は使えなくなりました。その素材は出なくなり、次の候補に代わります。${message}`];
      case 'studio.approved':
        return ['スタジオを出せるようになりました', `スタジオを出す申し込みを承認しました。管理システムの「スタジオ」からスタジオを作れます。スタジオの決まりを守ってください。${message}`];
      case 'studio.declined':
        return ['スタジオの申し込みを見送りました', `スタジオを出す申し込みを、今は見送りました。直せるものは、直して申し込み直せます。${message}`];
      case 'studio.suspended':
        return ['スタジオを止めました', `スタジオの決まりに反することがあったため、期間を決めてスタジオを止めました。載っていたスタジオも届けていません。${message}`];
      case 'studio.revoked':
        return ['スタジオの承認を取り消しました', `スタジオの決まりに反することがあったため、スタジオを出す承認を取り消しました。載っていたスタジオも消しました。${message}`];
      case 'placement.published':
        return ['申し出を受けてスタジオを載せました', `確認で返したスタジオについて申し出を受け、運営が確かめて載せました。${message}`];
      case 'placement.rejected':
        return ['申し出を受けてスタジオを載せないと決めました', `確認で返したスタジオについて申し出を受け、運営が確かめて、載せないと決めました。${message}`];
      case 'placement.removed':
        return ['通報を受けてスタジオを消しました', `スタジオについて通報を受け、運営が確かめて、スタジオの決まりに反するため消しました。${message}`];
      case 'placement.restored':
        return ['通報で止めたスタジオを戻しました', `通報を受けて止めていたスタジオを、運営が確かめて戻しました。期間の中であれば、また届きます。${message}`];
      case 'transfer.rejected':
        return ['鍵の移し替えを認めませんでした', `鍵の移し替えの申し出を認めませんでした。新しい鍵の紐づけは外しました。${message}`];
    }
  })();
  return { subject: `【SanpoGuide】${lines[0]}`, body: `${lines[1]}\n\n画面で確かめる: ${link}${FOOTER}` };
}

/**
 * Sends one notice. Throws when it should be retried; on the last attempt the failure is recorded
 * first (the message then goes to the dead-letter queue and the operator is alerted).
 */
export async function deliver(ports: NotifyPorts, notice: Notice, attempt: number, maxAttempts: number): Promise<'sent' | 'skipped' | 'duplicate'> {
  const key = { PK: `NOTICE#${notice.noticeId}`, SK: 'NOTICE' };
  if ((await ports.db.send(new GetCommand({ TableName: ports.table, Key: key, ConsistentRead: true }))).Item) return 'duplicate';
  const target = `PUB#${notice.publisherId}`;
  const record = (action: string, detail: Record<string, unknown>) => auditItem(ports, SYSTEM, { action, target, detail: { event: notice.event, noticeId: notice.noticeId, ...detail } });

  const pub = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: { PK: target, SK: 'PUB' } }))).Item;
  const to = pub && pub.status !== 'deleted' && pub.ownerSub ? await ports.emailOf(String(pub.ownerSub)) : undefined;
  if (!to) {
    await ports.db.send(new TransactWriteCommand({ TransactItems: [record('notification.failed', { error: 'no_verified_email' })] }));
    return 'skipped';
  }
  let messageId: string;
  try {
    messageId = await ports.send({ to, ...render(notice, ports.consoleUrl) });
  } catch (e) {
    if (attempt >= maxAttempts) {
      await ports.db.send(new TransactWriteCommand({ TransactItems: [record('notification.failed', { error: e instanceof Error ? e.name : 'error', attempts: attempt })] }));
    }
    throw e;
  }
  const ttl = Math.floor(ports.now().getTime() / 1000) + REMEMBER_DAYS * 86_400;
  await ports.db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: ports.table, Item: { ...key, type: 'notice', event: notice.event, messageId, ttl } } },
        record('notification.sent', { messageId }),
      ],
    }),
  );
  return 'sent';
}
