import type { WorkflowGraph } from "@orbyt/db";
import { describe, expect, it } from "vitest";
import {
  evaluate,
  graphSchema,
  nodeSchema,
  renderCtx,
  resolvePath,
  successors,
  validateGraph,
} from "./graph";

const trigger = { id: "t", type: "trigger", config: {} };
const tag = (id: string) => ({
  id,
  type: "tag",
  config: { add: ["x"], remove: [] },
});
const g = (nodes: object[], edges: WorkflowGraph["edges"]) =>
  ({ nodes, edges }) as WorkflowGraph;

describe("validateGraph", () => {
  it("accepts a linear flow and a branching flow", () => {
    expect(
      validateGraph(
        g(
          [trigger, tag("a"), tag("b")],
          [
            { from: "t", to: "a" },
            { from: "a", to: "b" },
          ],
        ),
      ),
    ).toEqual([]);
    const cond = {
      id: "c",
      type: "condition",
      config: { left: "x", op: "exists" },
    };
    expect(
      validateGraph(
        g(
          [trigger, cond, tag("yes"), tag("no")],
          [
            { from: "t", to: "c" },
            { from: "c", to: "yes", label: "true" },
            { from: "c", to: "no", label: "false" },
          ],
        ),
      ),
    ).toEqual([]);
    // Branches may merge again (a node still runs once).
    expect(
      validateGraph(
        g(
          [trigger, cond, tag("yes"), tag("no"), tag("end")],
          [
            { from: "t", to: "c" },
            { from: "c", to: "yes", label: "true" },
            { from: "c", to: "no", label: "false" },
            { from: "yes", to: "end" },
            { from: "no", to: "end" },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("rejects loops, unreachable nodes and a missing or duplicated trigger", () => {
    const loop = validateGraph(
      g(
        [trigger, tag("a"), tag("b")],
        [
          { from: "t", to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    );
    expect(loop.join()).toMatch(/loop/);
    expect(
      validateGraph(
        g([trigger, tag("a"), tag("island")], [{ from: "t", to: "a" }]),
      ).join(),
    ).toMatch(/island.*not reachable/);
    expect(validateGraph(g([tag("a")], [])).join()).toMatch(
      /exactly one trigger/,
    );
    expect(
      validateGraph(g([trigger, { ...trigger, id: "t2" }], [])).join(),
    ).toMatch(/exactly one trigger/);
    expect(
      validateGraph(
        g([trigger, tag("a"), tag("a")], [{ from: "t", to: "a" }]),
      ).join(),
    ).toMatch(/Duplicate/);
  });

  it("rejects bad edges and label misuse", () => {
    expect(
      validateGraph(g([trigger, tag("a")], [{ from: "t", to: "zzz" }])).join(),
    ).toMatch(/does not exist/);
    expect(
      validateGraph(
        g(
          [trigger, tag("a")],
          [
            { from: "t", to: "a" },
            { from: "a", to: "t" },
          ],
        ),
      ).join(),
    ).toMatch(/lead into the trigger/);
    const cond = {
      id: "c",
      type: "condition",
      config: { left: "x", op: "eq", right: "y" },
    };
    expect(
      validateGraph(
        g(
          [trigger, cond, tag("a")],
          [
            { from: "t", to: "c" },
            { from: "c", to: "a" },
          ],
        ),
      ).join(),
    ).toMatch(/must be labelled/);
    expect(
      validateGraph(
        g(
          [trigger, tag("a"), tag("b")],
          [
            { from: "t", to: "a", label: "true" },
            { from: "a", to: "b" },
          ],
        ),
      ).join(),
    ).toMatch(/Only condition/);
  });

  it("successors follow the chosen branch", () => {
    const graph = g(
      [trigger],
      [
        { from: "c", to: "yes", label: "true" },
        { from: "c", to: "no", label: "false" },
        { from: "t", to: "c" },
      ],
    );
    expect(successors(graph, "c", "true")).toEqual(["yes"]);
    expect(successors(graph, "c", "false")).toEqual(["no"]);
    expect(successors(graph, "t")).toEqual(["c"]);
  });
});

describe("node and graph schemas", () => {
  it("validate each node type's config and fill defaults", () => {
    expect(
      nodeSchema.parse({ id: "n", type: "tag", config: { add: ["a"] } }).config,
    ).toEqual({ add: ["a"], remove: [] });
    const http = nodeSchema.parse({
      id: "h",
      type: "http",
      config: { url: "https://example.com/x" },
    });
    expect(http).toMatchObject({ config: { method: "POST", headers: {} } });
  });

  it.each([
    [{ id: "n", type: "teleport", config: {} }],
    [{ id: "n", type: "wait", config: { minutes: -5 } }],
    [{ id: "n", type: "wait", config: {} }],
    [{ id: "n", type: "http", config: { url: "not a url" } }],
    [{ id: "n", type: "enroll_sequence", config: { sequenceId: "nope" } }],
    [{ id: "has space", type: "trigger", config: {} }],
    [{ id: "n", type: "condition", config: { left: "x", op: "regex" } }],
    [{ id: "n", type: "create_task", config: { title: "" } }],
  ])("rejects %j", (node) => {
    expect(nodeSchema.safeParse(node).success).toBe(false);
  });

  it("limits graph size", () => {
    const many = Array.from({ length: 101 }, (_, i) => tag(`n${i}`));
    expect(graphSchema.safeParse({ nodes: many, edges: [] }).success).toBe(
      false,
    );
    expect(graphSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false);
  });
});

describe("templating", () => {
  const ctx = {
    contact: { email: "ada@x.co", name: "Ada", customFields: { plan: "pro" } },
    event: { type: "deal.won", data: { value: 5000, tags: ["a", "b"] } },
    steps: { call: { output: { status: 200 } } },
  };

  it("resolves nested paths, fallbacks and objects", () => {
    expect(renderCtx("Hi {{contact.name}} <{{ contact.email }}>", ctx)).toBe(
      "Hi Ada <ada@x.co>",
    );
    expect(
      renderCtx("{{event.data.value}}/{{steps.call.output.status}}", ctx),
    ).toBe("5000/200");
    expect(renderCtx("{{contact.customFields.plan}}", ctx)).toBe("pro");
    expect(renderCtx("{{event.data.tags}}", ctx)).toBe('["a","b"]');
    expect(renderCtx("{{contact.phone | n/a}}", ctx)).toBe("n/a");
    expect(renderCtx("[{{missing.deep.path}}]", ctx)).toBe("[]");
    expect(renderCtx("no tags here", ctx)).toBe("no tags here");
  });

  it("never throws on missing or primitive parents", () => {
    expect(resolvePath(null, "a.b")).toBeUndefined();
    expect(resolvePath({ a: 5 }, "a.b.c")).toBeUndefined();
    expect(resolvePath({ a: { b: 0 } }, "a.b")).toBe(0);
  });
});

describe("evaluate", () => {
  it.each([
    ["eq", "a", "a", true],
    ["eq", "a", "b", false],
    ["neq", "a", "b", true],
    ["contains", "Hello World", "world", true],
    ["contains", "Hello", "x", false],
    ["not_contains", "Hello", "x", true],
    ["gt", "10", "9", true],
    ["gt", "9", "10", false], // numeric, not alphabetical
    ["lt", "2", "10", true],
    ["gt", "", "1", false],
    ["gt", "abc", "1", false],
    ["exists", "x", "", true],
    ["exists", "", "", false],
    ["not_exists", "", "", true],
  ] as const)("%s(%j, %j) = %s", (op, left, right, expected) => {
    expect(evaluate(op, left, right)).toBe(expected);
  });
});
