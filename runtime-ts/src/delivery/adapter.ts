/**
 * 交付适配器：把容器里的文件交给“人”。
 *
 * 现在的实现写到宿主机的 outbox 目录；以后接 Slack / 飞书时换成上传适配器，
 * 工具和账本都不用改。适配器抛错时，调用方不得记录台账。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export type DeliveryItem = {
  readonly name: string;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
};

export type DeliveryBatch = {
  readonly conversationId: string;
  readonly items: readonly DeliveryItem[];
};

export type DeliveryOutcome = {
  readonly name: string;
  /** 适配器把文件放到了哪里：本地路径，或以后的消息 id。 */
  readonly target: string;
  /** 目标位置已经有同样内容的文件，本次没有重写。 */
  readonly skipped: boolean;
};

export interface DeliveryAdapter {
  /** 全部成功才返回；任何一个失败就抛错，调用方据此不写台账。 */
  deliver(batch: DeliveryBatch): Promise<readonly DeliveryOutcome[]>;
}

const UNSAFE_NAME = /[^A-Za-z0-9._ -]+/g;
const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]+/g;

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** 与 Python 版一致：去掉路径分隔符和怪字符，保留扩展名。 */
export function deliveredName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const name = base.replace(UNSAFE_NAME, "-").replace(/^[ .]+|[ .]+$/g, "");
  return name.length === 0 ? "file" : name;
}

/** 一个 conversation 一个目录，避免不同线程的产物混在一起。 */
export function safeSegment(value: string): string {
  const segment = value.replace(UNSAFE_SEGMENT, "-").replace(/^[ .]+|[ .]+$/g, "").slice(0, 80);
  return segment.length === 0 ? "thread" : segment;
}

/** 不覆盖不同内容的同名文件：追加内容摘要后缀，必要时再加序号。 */
function targetFor(folder: string, item: DeliveryItem): string {
  const direct = join(folder, item.name);
  if (!existsSync(direct)) return direct;
  if (sha256Of(readFileSync(direct)) === item.sha256) return direct;

  const extension = extname(item.name);
  const stem = item.name.slice(0, item.name.length - extension.length);
  const suffixed = join(folder, `${stem}-${item.sha256.slice(0, 8)}${extension}`);
  if (!existsSync(suffixed)) return suffixed;

  for (let index = 2; ; index += 1) {
    const candidate = join(folder, `${stem}-${item.sha256.slice(0, 8)}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
}

export class LocalOutboxAdapter implements DeliveryAdapter {
  constructor(private readonly root: string) {}

  folderFor(conversationId: string): string {
    return join(this.root, safeSegment(conversationId));
  }

  async deliver(batch: DeliveryBatch): Promise<readonly DeliveryOutcome[]> {
    const folder = this.folderFor(batch.conversationId);
    mkdirSync(folder, { recursive: true });

    return batch.items.map((item) => {
      const target = targetFor(folder, item);
      if (existsSync(target) && sha256Of(readFileSync(target)) === item.sha256) {
        return { name: item.name, target, skipped: true };
      }

      // 先写临时文件再改名，读的人不会看到半个文件。
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, item.bytes);
      renameSync(temporary, target);
      return { name: item.name, target, skipped: false };
    });
  }
}
