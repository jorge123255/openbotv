import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  CreateLocalSkillInput,
  InstallLocalSkillInput,
  LocalSkillRevisionInput,
  ReviseLocalSkillInput,
  ShareLocalSkillInput,
} from "@openbot/contracts/ipc";
import { z } from "zod";
import {
  createSkillSchema,
  installLocalSkillSchema,
  readSkillSchema,
  reviseSkillSchema,
} from "../../backend/agent/skill-tools";

const agentId = z.string().min(1).max(INPUT_LIMITS.identifier);
export const parseCreateLocalSkill = (input: unknown): CreateLocalSkillInput =>
  createSkillSchema.extend({ agentId }).parse(input);
export const parseReviseLocalSkill = (input: unknown): ReviseLocalSkillInput =>
  reviseSkillSchema.extend({ agentId }).parse(input);
export const parseReadLocalSkill = (input: unknown): LocalSkillRevisionInput => {
  const { skillId, revision } = readSkillSchema.parse(input);
  return revision === undefined ? { skillId } : { skillId, revision };
};
export const parseInstallLocalSkill = (input: unknown): InstallLocalSkillInput =>
  installLocalSkillSchema.extend({ agentId }).parse(input);

export const parseLocalSkillShareReview = (input: unknown): Pick<InstallLocalSkillInput, "skillId" | "revision"> =>
  installLocalSkillSchema.omit({ agentId: true }).parse(input);
export const parseShareLocalSkill = (input: unknown): ShareLocalSkillInput =>
  installLocalSkillSchema
    .omit({ agentId: true })
    .extend({
      bundleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      agentIds: z
        .array(agentId)
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      reviewed: z.literal(true),
    })
    .parse(input);
