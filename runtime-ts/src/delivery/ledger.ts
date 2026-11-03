/**
 * 交付台账：每个对话一份，记录已经确认送达的文件。
 *
 * 键是「工作区路径 + sha256」：内容变了就可以再送一次，同一个文件不会送第二次。
 * 只有适配器报告成功之后才写入；写台账和工具结果的提交不在同一个事务里，
 * 所以“发出去但没来得及记账”仍然可能重复一次——这是外部副作用的固有边界。
 */
import { defineDoc } from "@earendil-works/pi-durable";

export type DeliveryRecord = {
  /** 容器里的绝对路径。 */
  path: string;
  sha256: string;
  /** 交付时使用的文件名。 */
  name: string;
  bytes: number;
  /** 适配器返回的落点：本地路径，或以后的消息 id。 */
  target: string;
  /** 毫秒时间戳。 */
  at: number;
};

export type DeliveryLedgerValue = {
  deliveries: DeliveryRecord[];
};

export const DeliveryLedgerDoc = defineDoc({
  kind: "design.delivery",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): DeliveryLedgerValue => ({ deliveries: [] }),
  // 台账很小，每次变化都存完整副本，读取时不用回放增量。
  checkpointWhen: () => true,
});

export const alreadyDelivered = (
  ledger: DeliveryLedgerValue | undefined,
  path: string,
  sha256: string,
): boolean =>
  ledger?.deliveries.some((record) => record.path === path && record.sha256 === sha256) ?? false;
