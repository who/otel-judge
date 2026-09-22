import { describe, expect, it } from "vitest";

/**
 * The boundary, as source text.
 *
 * The drop-into-Slack test is a claim about dependency direction: a channel may
 * reach the Agent, and nothing the Agent holds may reach back. A bundle check
 * cannot see that — bundling inlines the modules and the violation disappears
 * into one file — so this guard reads the source the moment it is written,
 * which is when moving the import is still cheap.
 *
 * Directories are matched after resolution, names are matched as whole path or
 * package tokens, so `@slack/bolt` and `../../ingress/otlp` are both caught
 * while a module called `packages.ts` is not.
 */
const FORBIDDEN_DIRECTORIES = ["src/worker/", "src/ingress/"] as const;
const FORBIDDEN_NAMES = ["slack", "pages", "demo"] as const;

/**
 * Every file the guard expects to scan.
 *
 * Maintained by hand on purpose: the glob below finds what is actually there,
 * and comparing the two is what turns "someone added a module" into a failing
 * test rather than a silently smaller scan. A `.test.ts` file placed under
 * these directories is scanned like any other module — the exemption is for
 * tests that live in `test/`, which wire the door to the Agent deliberately and
 * are not part of what ships inside the Agent.
 */
const GUARDED_MODULES = [
  "src/agent/OtelJudgeAgent.ts",
  "src/agent/accept.ts",
  "src/agent/api-types.ts",
  "src/agent/boardState.ts",
  "src/agent/identity.ts",
  "src/agent/persist.ts",
  "src/agent/state.ts",
  "src/agent/store.ts",
  "src/workflow/EvaluateWorkflow.ts",
  "src/workflow/evaluate.ts",
  "src/workflow/summarize.ts",
] as const;

/**
 * Source text arrives as an inlined import map because tests run in workerd,
 * where there is no filesystem to walk. Vite builds the map at transform time;
 * the cast supplies the signature without pulling Vite's client types into a
 * Workers-typed test project.
 */
interface RawGlobHost {
  glob(
    patterns: string[],
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}

const globbed = (import.meta as unknown as RawGlobHost).glob(
  ["../src/agent/**/*.ts", "../src/workflow/**/*.ts"],
  { query: "?raw", import: "default", eager: true },
);

/** Glob keys are relative to this file; the guard talks in repository paths. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(globbed).map(([key, text]) => [key.replace(/^(?:\.\.\/)+/, ""), text]),
);

/**
 * Remove comments, keep string bodies.
 *
 * Prose in this repository is dense and quotes freely, and a sentence naming a
 * channel must never fail the build; specifiers, meanwhile, live inside the
 * strings that have to survive. Regular expressions are stepped over rather
 * than parsed as division, because an escaped slash pair inside one would
 * otherwise read as the start of a line comment and swallow the rest of a line.
 */
function stripComments(source: string): string {
  const regexAllowedAfter = new Set("([{,;:=><!&|?+-*%~^".split(""));
  let output = "";
  let index = 0;
  let lastSignificant = "";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index += 2;
      continue;
    }

    if (char === "/" && (lastSignificant === "" || regexAllowedAfter.has(lastSignificant))) {
      index++;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index];
        index++;
        if (inner === "\\") {
          index++;
          continue;
        }
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) break;
        else if (inner === "\n") break;
      }
      lastSignificant = "/";
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      output += char;
      index++;
      while (index < source.length) {
        const inner = source[index];
        output += inner;
        index++;
        if (inner === "\\") {
          output += source[index] ?? "";
          index++;
          continue;
        }
        if (inner === char) break;
      }
      lastSignificant = char;
      continue;
    }

    output += char;
    index++;
    if (!/\s/.test(char)) lastSignificant = char;
  }

  return output;
}

/**
 * Every form that creates a dependency: the static import, its type-only
 * spelling, the side-effect import, the re-export, and the dynamic call. A type
 * import counts — a type that names a channel's shape couples the Agent to that
 * channel just as surely as a value does, it only fails later.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** Resolve a relative specifier to a repository path; leave a bare one alone. */
function resolveSpecifier(fromModule: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const segments = fromModule.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/** What the specifier crossed into, or undefined when it stayed on this side. */
function crossing(fromModule: string, specifier: string): string | undefined {
  const resolved = resolveSpecifier(fromModule, specifier).toLowerCase();
  const directory = FORBIDDEN_DIRECTORIES.find(
    (dir) => resolved.startsWith(dir) || resolved.includes(`/${dir}`),
  );
  if (directory) return directory;

  const tokens = resolved.split(/[^a-z0-9]+/).filter(Boolean);
  return FORBIDDEN_NAMES.find((name) => tokens.includes(name));
}

function violations(): string[] {
  return Object.entries(SOURCES).flatMap(([module, source]) =>
    importSpecifiers(source)
      .map((specifier) => {
        const crossed = crossing(module, specifier);
        return crossed ? `${module} imports "${specifier}" (crosses into ${crossed})` : "";
      })
      .filter((message) => message.length > 0),
  );
}

describe("channel portability", () => {
  it("keeps the agent side of the boundary clear of door, ingress, and channel imports", () => {
    expect(violations()).toEqual([]);
  });

  it("keeps map coverage complete, so a new module cannot escape the scan", () => {
    expect(Object.keys(SOURCES).sort()).toEqual([...GUARDED_MODULES]);
    for (const module of GUARDED_MODULES) {
      expect(SOURCES[module]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("reads import specifiers, not prose or values that happen to name a channel", () => {
    const source = [
      '// The Slack adapter would live in src/ingress/slack.ts one day.',
      '/* src/worker/router.ts owns the route, not this file. */',
      'const channel = "slack";',
      'const pattern = /https:\\/\\/pages.example/;',
      'import { corsHeaders } from "../worker/cors";',
      'import type { OtlpIngestBody } from "../ingress/otlp";',
      'export * from "../worker/errors";',
      'const late = () => import("@slack/bolt");',
      'import { DEFAULT_AGENT_NAME } from "./identity";',
    ].join("\n");

    const specifiers = importSpecifiers(source);
    expect(specifiers).toEqual([
      "../worker/cors",
      "../ingress/otlp",
      "./identity",
      "../worker/errors",
      "@slack/bolt",
    ]);

    const crossed = specifiers
      .map((specifier) => crossing("src/agent/example.ts", specifier))
      .filter(Boolean);
    expect(crossed).toEqual(["src/worker/", "src/ingress/", "src/worker/", "slack"]);
  });
});
