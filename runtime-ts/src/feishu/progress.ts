/** 长任务的进度文案：从 pi.live 和活跃任务里取一句人话。 */
import type { LiveState } from "@earendil-works/pi-durable";

export function progressLine(
  live: LiveState | undefined,
  taskKinds: readonly string[],
  elapsedMinutes: number,
): string {
  const parts: string[] = [];
  const active = live?.tools?.find(
    (slot) => slot.status === "running" || slot.status === "pending",
  );

  if (active !== undefined) parts.push(`正在执行 ${active.name}`);
  else if (taskKinds.includes("pi.generation")) parts.push("正在生成");

  if (live?.run !== undefined) parts.push(`第 ${Math.max(1, live.run.turns)} 轮`);
  if (taskKinds.includes("render")) parts.push("后台任务运行中");
  if (parts.length === 0) parts.push("任务仍在运行");

  return `还在处理（已 ${elapsedMinutes} 分钟）：${parts.join("；")}。`;
}
