import { describe, expect, it } from "vitest";

import { loadCodexProtocolCatalog, parseCodexProtocolCatalog } from "./protocol-catalog.js";

describe("parseCodexProtocolCatalog", () => {
  it("discovers current string options without treating structured policies as buttons", () => {
    expect(
      parseCodexProtocolCatalog({
        definitions: {
          ApprovalsReviewer: {
            enum: ["user", "auto_review", "future-reviewer"],
            type: "string",
          },
          AskForApproval: {
            oneOf: [
              { enum: ["untrusted", "on-request", "never", "future-policy"], type: "string" },
              { properties: { granular: { type: "object" } }, type: "object" },
            ],
          },
        },
        oneOf: [
          {
            properties: {
              method: {
                enum: [
                  "thread/compact/start",
                  "thread/goal/get",
                  "thread/goal/set",
                  "thread/goal/clear",
                  "thread/settings/update",
                ],
                type: "string",
              },
            },
            type: "object",
          },
        ],
      }),
    ).toEqual({
      approvalPolicies: ["untrusted", "on-request", "never", "future-policy"],
      approvalReviewers: ["user", "auto_review", "future-reviewer"],
      clientMethods: [
        "thread/compact/start",
        "thread/goal/get",
        "thread/goal/set",
        "thread/goal/clear",
        "thread/settings/update",
      ],
      serverRequestDecisionFallbacks: {},
    });
  });

  it("discovers legacy approval decisions from the current generated response schema", () => {
    expect(
      parseCodexProtocolCatalog(
        { definitions: {} },
        {
          definitions: {
            ExecParams: {
              properties: {
                conversationId: { type: "string" },
              },
              type: "object",
            },
          },
          oneOf: [
            {
              properties: {
                method: { enum: ["execCommandApproval"], type: "string" },
                params: { $ref: "#/definitions/ExecParams" },
              },
              title: "ExecCommandApprovalRequest",
              type: "object",
            },
          ],
        },
        {
          ExecCommandApprovalResponse: {
            definitions: {
              ReviewDecision: {
                oneOf: [
                  {
                    description: "User approved this command.",
                    enum: ["approved"],
                    type: "string",
                  },
                  {
                    description: "Approved for this session.",
                    enum: ["approved_for_session"],
                    type: "string",
                  },
                  {
                    description: "User denied this command.",
                    properties: {
                      denied: {
                        properties: {
                          rejection: { type: "string" },
                        },
                        required: ["rejection"],
                        type: "object",
                      },
                    },
                    required: ["denied"],
                    title: "DeniedReviewDecision",
                    type: "object",
                  },
                  {
                    description: "Automatic approval review timed out.",
                    enum: ["timed_out"],
                    type: "string",
                  },
                  {
                    description: "User denied and stopped.",
                    enum: ["abort"],
                    type: "string",
                  },
                ],
              },
            },
            properties: {
              decision: { $ref: "#/definitions/ReviewDecision" },
            },
            type: "object",
          },
        },
      ),
    ).toEqual({
      approvalPolicies: [],
      approvalReviewers: [],
      clientMethods: [],
      serverRequestDecisionFallbacks: {
        execCommandApproval: [
          "approved",
          "approved_for_session",
          { denied: { rejection: "用户拒绝" } },
          "abort",
        ],
      },
    });
  });

  it("discovers namespaced file approval decisions from the response named after params", () => {
    expect(
      parseCodexProtocolCatalog(
        { definitions: {} },
        {
          definitions: {
            FileChangeRequestApprovalParams: {
              properties: {
                threadId: { type: "string" },
              },
              type: "object",
            },
          },
          oneOf: [
            {
              properties: {
                method: {
                  enum: ["item/fileChange/requestApproval"],
                  type: "string",
                },
                params: {
                  $ref: "#/definitions/FileChangeRequestApprovalParams",
                },
              },
              title: "Item/fileChange/requestApprovalRequest",
              type: "object",
            },
          ],
        },
        {
          FileChangeRequestApprovalResponse: {
            definitions: {
              FileChangeApprovalDecision: {
                oneOf: [
                  { enum: ["accept"], type: "string" },
                  { enum: ["acceptForSession"], type: "string" },
                  { enum: ["decline"], type: "string" },
                  { enum: ["cancel"], type: "string" },
                ],
              },
            },
            properties: {
              decision: {
                $ref: "#/definitions/FileChangeApprovalDecision",
              },
            },
            type: "object",
          },
        },
      ),
    ).toMatchObject({
      serverRequestDecisionFallbacks: {
        "item/fileChange/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
  });

  it("keeps response-schema decisions as a safe fallback when runtime decisions are nullable", () => {
    expect(
      parseCodexProtocolCatalog(
        { definitions: {} },
        {
          definitions: {
            CommandExecutionRequestApprovalParams: {
              properties: {
                availableDecisions: {
                  items: { type: "string" },
                  type: ["array", "null"],
                },
                threadId: { type: "string" },
              },
              type: "object",
            },
          },
          oneOf: [
            {
              properties: {
                method: {
                  enum: ["item/commandExecution/requestApproval"],
                  type: "string",
                },
                params: {
                  $ref: "#/definitions/CommandExecutionRequestApprovalParams",
                },
              },
              title: "Item/commandExecution/requestApprovalRequest",
              type: "object",
            },
          ],
        },
        {
          CommandExecutionRequestApprovalResponse: {
            definitions: {
              CommandExecutionApprovalDecision: {
                oneOf: [
                  { enum: ["accept"], type: "string" },
                  { enum: ["acceptForSession"], type: "string" },
                  { enum: ["decline"], type: "string" },
                  { enum: ["cancel"], type: "string" },
                ],
              },
            },
            properties: {
              decision: {
                $ref: "#/definitions/CommandExecutionApprovalDecision",
              },
            },
            type: "object",
          },
        },
      ),
    ).toMatchObject({
      serverRequestDecisionFallbacks: {
        "item/commandExecution/requestApproval": [
          "accept",
          "acceptForSession",
          "decline",
          "cancel",
        ],
      },
    });
  });

  it("fails closed when no current Codex executable is available", async () => {
    await expect(loadCodexProtocolCatalog(undefined)).resolves.toEqual({
      approvalPolicies: [],
      approvalReviewers: [],
      clientMethods: [],
      serverRequestDecisionFallbacks: {},
    });
  });
});
