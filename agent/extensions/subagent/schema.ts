import { Type, type Static } from "typebox";

/** TypeBox schema for the delegate tool parameters */
export const subagentSchema = Type.Object({
    agent: Type.String({
        description:
            "要调用的子代理名称。可用子代理参见工具描述（delegate tool description）中的完整列表。",
    }),
    task: Type.String({
        description: "委派给子代理的具体任务描述。应详细说明期望子代理完成什么。",
    }),
    timeout: Type.Optional(
        Type.Number({
            description:
                "超时时间（毫秒）。覆盖预设的默认超时值。例如 60000 表示 1 分钟。",
        }),
    ),
});

/** Inferred TypeScript type for delegate tool input */
export type SubagentToolInput = Static<typeof subagentSchema>;
