/**
 * 飞书网络层：只做发送和上传，方便测试时替换成假实现。
 */
import * as lark from "@larksuiteoapi/node-sdk";

const MAX_TEXT = 3_500;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export interface FeishuTransport {
  /** 发文本，返回每条消息的 message_id。长文本会拆成多条。 */
  replyText(messageId: string, text: string, uuid: string): Promise<string[]>;
  replyImage(messageId: string, imageKey: string, uuid: string): Promise<string>;
  replyFile(messageId: string, fileKey: string, fileName: string, uuid: string): Promise<string>;
  uploadImage(bytes: Uint8Array): Promise<string>;
  uploadFile(bytes: Uint8Array, fileName: string): Promise<string>;
}

/** 长文本按行切成若干段；没有合适的换行就硬切。 */
export function chunkText(text: string, limit = MAX_TEXT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const split = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"));
    const cut = split > limit / 2 ? split + 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

const fileTypeOf = (name: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" => {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".mp4") return "mp4";
  if (extension === ".opus") return "opus";
  return "stream";
};

export const isImageName = (name: string): boolean =>
  IMAGE_EXTENSIONS.has(name.slice(name.lastIndexOf(".")).toLowerCase());

export class FeishuSdkTransport implements FeishuTransport {
  readonly #client: lark.Client;

  constructor(appId: string, appSecret: string) {
    this.#client = new lark.Client({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async replyText(messageId: string, text: string, uuid: string): Promise<string[]> {
    const chunks = chunkText(text);
    const ids: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const response = await this.#client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
          uuid: chunks.length === 1 ? uuid : `${uuid}-${index + 1}`,
        },
      });
      ids.push(response.data?.message_id ?? "-");
    }
    return ids;
  }

  async replyImage(messageId: string, imageKey: string, uuid: string): Promise<string> {
    const response = await this.#client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "image", content: JSON.stringify({ image_key: imageKey }), uuid },
    });
    return response.data?.message_id ?? "-";
  }

  async replyFile(
    messageId: string,
    fileKey: string,
    fileName: string,
    uuid: string,
  ): Promise<string> {
    const response = await this.#client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey, file_name: fileName }),
        uuid,
      },
    });
    return response.data?.message_id ?? "-";
  }

  async uploadImage(bytes: Uint8Array): Promise<string> {
    const response = await this.#client.im.v1.image.create({
      data: { image_type: "message", image: Buffer.from(bytes) },
    });
    const key = response?.image_key;
    if (key === undefined) throw new Error("飞书没有返回 image_key");
    return key;
  }

  async uploadFile(bytes: Uint8Array, fileName: string): Promise<string> {
    const response = await this.#client.im.v1.file.create({
      data: {
        file_type: fileTypeOf(fileName),
        file_name: fileName,
        file: Buffer.from(bytes),
      },
    });
    const key = response?.file_key;
    if (key === undefined) throw new Error("飞书没有返回 file_key");
    return key;
  }
}
