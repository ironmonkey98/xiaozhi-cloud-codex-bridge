import { z } from 'zod';

/** 接入点命名空间：一个小智 MCP 接入点 = 一个受信用户/设备组。由配置注入，不由 LLM 提供。 */
export const namespaceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const projectIdSchema = z.string().trim().min(1).max(32).describe('项目别名，来自 codex_list_projects');

export const taskIdSchema = z.string().trim().min(1).max(20).describe('任务号，例如 T-12');

export const instructionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1500)
  .describe('用中文描述任务。只读项目用于分析；writable 项目可自动安装项目依赖、联网下载、运行程序和生成 PPT 等文件，产物留在项目文件夹内');

export const clientRequestIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
  .optional()
  .describe('可选的请求去重标识；同一标识重复提交只会执行一次');

export const submitBodySchema = z.object({
  project_id: projectIdSchema,
  instruction: instructionSchema,
  client_request_id: clientRequestIdSchema,
  kind: z.enum(['submit', 'continue']),
});

export type SubmitBody = z.infer<typeof submitBodySchema>;

export const recordingIdSchema = z.string().regex(/^[a-f0-9]{32}$/).describe('录音编号，省略时选择最近已转写完成的录音');
export const recordingListInputSchema = z.object({}).strict();
export const recordingTranscriptInputSchema = z.object({ recording_id: recordingIdSchema.optional() }).strict();
export const recordingSubmitInputSchema = z.object({
  project_id: projectIdSchema,
  instruction: instructionSchema,
  recording_id: recordingIdSchema.optional(),
  client_request_id: clientRequestIdSchema,
}).strict();
