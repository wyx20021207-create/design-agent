/**
 * 飞书交付：把 upload_files 的批次上传到飞书并回复在线程里。
 *
 * 不是飞书线程的 conversation（比如 HTTP API 建的）仍然走本地 outbox。
 * 飞书图片上限 10 MB、文件上限 30 MB；超限的图片退化成文件发送。
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";

import type { DeliveryAdapter, DeliveryBatch, DeliveryOutcome } from "../delivery/adapter.ts";
import { isImageName, type FeishuTransport } from "./client.ts";
import { feishuTargetForConversation } from "./state.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export class FeishuDeliveryAdapter implements DeliveryAdapter {
  constructor(
    private readonly harness: () => Harness,
    private readonly transport: FeishuTransport,
    private readonly local: DeliveryAdapter,
  ) {}

  async deliver(batch: DeliveryBatch): Promise<readonly DeliveryOutcome[]> {
    const target = await feishuTargetForConversation(
      this.harness(),
      batch.conversationId,
      ctx,
    );
    if (target === undefined) return this.local.deliver(batch);

    const outcomes: DeliveryOutcome[] = [];
    for (const item of batch.items) {
      if (item.bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error("文件超过飞书 30 MB 的上限");
      }

      const uuid = `da-file-${item.sha256.slice(0, 16)}`;
      const asImage = isImageName(item.name) && item.bytes.byteLength <= MAX_IMAGE_BYTES;
      let messageId: string;
      if (asImage) {
        const key = await this.transport.uploadImage(item.bytes);
        messageId = await this.transport.replyImage(target.rootMessageId, key, uuid);
      } else {
        const key = await this.transport.uploadFile(item.bytes, item.name);
        messageId = await this.transport.replyFile(target.rootMessageId, key, item.name, uuid);
      }
      outcomes.push({ name: item.name, target: `feishu:${messageId}`, skipped: false });
    }

    // 本地也留一份，HTTP 的 /files 仍然能下载。
    await this.local.deliver(batch);
    return outcomes;
  }
}
