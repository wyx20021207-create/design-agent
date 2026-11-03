/**
 * 项目状态：最近的项目、一个项目的渲染与 run.json 进度。
 *
 * 只读线程自己的 /workspace/projects，不碰宿主机的仓库。
 */
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord/context";

const PROJECTS_ROOT = "/workspace/projects";
const OUTPUT_SUFFIXES = [
  ".mp4",
  ".mov",
  ".webm",
  ".gif",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".pdf",
  ".svg",
  ".wav",
  ".mp3",
];
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const STAGE_FILES = ["BRIEF.md", "PLAN.md", "run.json", "DELIVERY.json"];
const RUN_FIELDS = ["status", "phase", "step", "eta", "cost_usd", "started_at", "finished_at"];

const text = (message: string) => [{ type: "text" as const, text: message }];
const fail = (message: string) => ({ output: text(message), isError: true });

const isOutput = (name: string): boolean =>
  OUTPUT_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));

async function outputsOf(
  env: ExecutionEnv,
  project: string,
  context: Context,
): Promise<string[]> {
  const listing = await env.listDir(`${project}/renders`, context);
  if (!listing.ok) return [];
  return listing.value
    .filter((entry) => entry.kind === "file" && isOutput(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function listProjects(
  env: ExecutionEnv,
  limit: number,
  context: Context,
): Promise<string> {
  const listing = await env.listDir(PROJECTS_ROOT, context);
  if (!listing.ok) return "No projects yet.";

  const projects = listing.value
    .filter((entry) => entry.kind === "directory" && SLUG.test(entry.name))
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
  if (projects.length === 0) return "No projects yet.";

  const capped = Math.max(1, Math.min(limit, 50));
  const rows: string[] = [];
  for (const entry of projects.slice(0, capped)) {
    const outputs = await outputsOf(env, `${PROJECTS_ROOT}/${entry.name}`, context);
    const state = outputs.length > 0 ? `${outputs.length} render(s)` : "in progress";
    rows.push(`- ${entry.name} (updated ${new Date(entry.mtimeMs).toISOString()}): ${state}`);
  }
  return `${projects.length} project(s); ${Math.min(capped, projects.length)} most recent:\n${rows.join("\n")}`;
}

export async function renderStatus(
  env: ExecutionEnv,
  slug: string,
  context: Context,
): Promise<string> {
  if (!SLUG.test(slug)) return "Project name is not allowed; use one project folder name.";
  const project = `${PROJECTS_ROOT}/${slug}`;

  const listing = await env.listDir(project, context);
  if (!listing.ok) return `No project named '${slug}'.`;

  const names = new Set(listing.value.map((entry) => entry.name));
  const stages = STAGE_FILES.map((name) => `${name} ${names.has(name) ? "yes" : "no"}`).join(", ");
  const outputs = await outputsOf(env, project, context);

  let summary = "not written yet";
  if (names.has("run.json")) {
    const run = await env.readTextFile(`${project}/run.json`, context);
    if (!run.ok) {
      summary = "present (unreadable)";
    } else {
      try {
        const parsed = JSON.parse(run.value) as Record<string, unknown>;
        const picked: Record<string, unknown> = {};
        for (const field of RUN_FIELDS) {
          if (field in parsed) picked[field] = parsed[field];
        }
        summary = Object.keys(picked).length > 0 ? JSON.stringify(picked) : "present";
      } catch {
        summary = "present (unreadable)";
      }
    }
  }

  return [
    slug,
    `files: ${stages}`,
    `renders: ${outputs.length > 0 ? outputs.join(", ") : "none yet"}`,
    `run.json: ${summary}`,
  ].join("\n");
}

export const listProjectsTool = defineTool({
  name: "list_recent_projects",
  description:
    "List recent projects in this thread's computer and whether each has renders. " +
    "Renders existing does not mean anything was delivered.",
  parameters: obj({
    limit: opt(num({ description: "How many recent projects to list, 1 to 50. Default 10." })),
  }),

  async execute(args, api, context) {
    const env = api.env;
    if (env === undefined) return fail("this run has no workspace.");
    return { output: text(await listProjects(env, args.limit ?? 10, context)) };
  },
});

export const renderStatusTool = defineTool({
  name: "get_render_status",
  description:
    "One project's files on disk, its renders and the status fields of its run.json. " +
    "Pass one project folder name.",
  parameters: obj({
    project: str({ description: "Project folder name under /workspace/projects." }),
  }),

  async execute(args, api, context) {
    const env = api.env;
    if (env === undefined) return fail("this run has no workspace.");
    return { output: text(await renderStatus(env, args.project, context)) };
  },
});
