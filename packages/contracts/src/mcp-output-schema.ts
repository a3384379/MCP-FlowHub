/** A text adapter without a downstream schema has a stable, explicit envelope. */
export function mcpOutputSchema(outputSchema: Record<string, unknown> | undefined, adapter = "structured"): Record<string, unknown> | undefined {
  if (outputSchema !== undefined) return outputSchema;
  if (adapter !== "text") return undefined;
  return {
    type: "object",
    properties: {
      text: { type: "string" },
      content: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["text", "content"],
    additionalProperties: false,
  };
}
