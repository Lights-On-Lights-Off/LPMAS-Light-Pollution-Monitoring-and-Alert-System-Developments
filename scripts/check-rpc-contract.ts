/**
 * Cross-layer check: do the TypeScript Edge Functions and the SQL migrations
 * agree on every RPC they share?
 *
 * A mismatch here is the most expensive kind of bug in this system: both
 * layers typecheck, both parse, and the pipeline still fails at runtime with
 * a PostgREST error nothing in CI would have caught. Neither language's
 * tooling can see the other's argument names, so it is checked here.
 *
 * The check is deliberately strict about its own coverage: if it cannot
 * enumerate the RPC call sites, it FAILS rather than reporting a clean run.
 * A contract checker that silently finds nothing is worse than no checker.
 *
 * Run: deno run --allow-read scripts/check-rpc-contract.ts
 */

/** Recursively lists files under `dir` whose name ends with `suffix`. */
async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      // One level of nesting is enough for supabase/functions/<name>/index.ts.
      found.push(...await listFiles(`${dir}/${entry.name}`, suffix));
    } else if (entry.name.endsWith(suffix)) {
      found.push(`${dir}/${entry.name}`);
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// SQL side
// ---------------------------------------------------------------------------

interface SqlParam {
  name: string;
  hasDefault: boolean;
}

interface SqlFunction {
  name: string;
  params: SqlParam[];
  file: string;
}

/**
 * Extracts CREATE FUNCTION signatures, tolerating newlines between the name,
 * the parameter list and RETURNS.
 */
function parseFunctions(sql: string, file: string): SqlFunction[] {
  const functions: SqlFunction[] = [];
  const pattern =
    /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\)\s*returns\s+([\w\s[\]".]+)/gi;

  for (const match of sql.matchAll(pattern)) {
    const [, rawName, rawParams] = match;
    const name = rawName.split(".").pop()!;

    const params = rawParams
      .split(",")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => ({
        // The parameter name is the first token; the rest is the type.
        name: part.replace(/\s+default[\s\S]*$/i, "").trim().split(/\s+/)[0],
        hasDefault: /\sdefault\s/i.test(part),
      }));

    functions.push({ name, params, file });
  }

  return functions;
}

// ---------------------------------------------------------------------------
// TypeScript side
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  /** Argument keys at the call site, or null when they come from a variable. */
  args: string[] | null;
  argsExpression: string;
  file: string;
  line: number;
}

/**
 * Finds `rpc("name", <args>)` and recovers the argument keys.
 *
 * Handles both an inline object literal and an identifier passed through,
 * by resolving simple object-returning helpers in the same file.
 */
function parseRpcCalls(source: string, file: string): RpcCall[] {
  const calls: RpcCall[] = [];

  for (const match of source.matchAll(/\.rpc\(/g)) {
    // Scan forward with paren counting rather than a regex: the argument list
    // contains nested calls, and a lazy regex stops at the first inner ")".
    const start = match.index! + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    if (depth !== 0) continue; // Unterminated; treat as unparsed.

    const callArgs = source.slice(start, i - 1);
    const line = source.slice(0, match.index).split("\n").length;

    // Split on the first top-level comma: the first argument is the name.
    let depthParen = 0;
    let depthBrace = 0;
    let splitAt = -1;
    for (let k = 0; k < callArgs.length; k++) {
      const ch = callArgs[k];
      if (ch === "(" || ch === "[" || ch === "{") { depthParen++; depthBrace++; continue; }
      if (ch === ")" || ch === "]" || ch === "}") { depthParen--; depthBrace--; continue; }
      if (ch === "," && depthParen === 0) { splitAt = k; break; }
    }
    if (splitAt === -1) continue;

    const fn = callArgs.slice(0, splitAt).trim().replace(/["'`]/g, "");
    const argsExpression = callArgs.slice(splitAt + 1).trim().replace(/,$/, "").trim();

    let args: string[] | null = null;

    if (argsExpression.startsWith("{") && argsExpression.endsWith("}")) {
      args = argsExpression
        .slice(1, -1)
        .split(",")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => part.split(":")[0].trim().replace(/^\.\.\./, ""));
    } else {
      // An identifier or call: resolve it against a helper defined in this
      // file that returns an object literal. Located by brace matching rather
      // than a regex, because the return block contains nested braces.
      const helperName = argsExpression.split("(")[0].trim();
      const fnIndex = source.search(new RegExp(`function\\s+${helperName}\\s*\\(`));
      if (fnIndex !== -1) {
        const returnIndex = source.indexOf("return {", fnIndex);
        if (returnIndex !== -1) {
          const openBrace = source.indexOf("{", returnIndex);
          let depth = 0;
          let end = -1;
          for (let k = openBrace; k < source.length; k++) {
            if (source[k] === "{") depth++;
            else if (source[k] === "}") {
              depth--;
              if (depth === 0) { end = k; break; }
            }
          }
          if (end !== -1) {
            const body = source.slice(openBrace + 1, end);
            args = body
              .split(",")
              .map(part => part.trim())
              .filter(Boolean)
              .map(part => part.split(":")[0].trim());
          }
        }
      }
    }

    calls.push({ fn, args, argsExpression, file, line });
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const MIGRATIONS = "supabase/migrations";
const problems: string[] = [];

const sqlFunctions: SqlFunction[] = [];
for (const path of await listFiles(MIGRATIONS, ".sql")) {
  sqlFunctions.push(...parseFunctions(await Deno.readTextFile(path), path));
}

const byName = new Map<string, SqlFunction[]>();
for (const fn of sqlFunctions) {
  if (!byName.has(fn.name)) byName.set(fn.name, []);
  byName.get(fn.name)!.push(fn);
}

const tsCalls: RpcCall[] = [];
for (const path of await listFiles("supabase/functions", "index.ts")) {
  tsCalls.push(...parseRpcCalls(await Deno.readTextFile(path), path));
}

console.log(`SQL functions parsed:  ${sqlFunctions.length}`);
console.log(`RPC call sites parsed: ${tsCalls.length}`);
console.log();

if (!tsCalls.length) {
  console.error(
    "FATAL: no RPC call sites could be enumerated. The checker cannot vouch for\n" +
      "       anything if it cannot see the calls — fix the parser before trusting a result."
  );
  Deno.exit(1);
}

for (const call of tsCalls) {
  const candidates = byName.get(call.fn);

  if (!candidates) {
    problems.push(
      `${call.file}:${call.line} calls rpc("${call.fn}") but no migration defines that function`
    );
    continue;
  }

  if (call.args === null) {
    // Refuse to guess: an unresolvable argument list is a gap in coverage,
    // not a pass.
    problems.push(
      `${call.file}:${call.line} rpc("${call.fn}") arguments could not be resolved ` +
        `from \`${call.argsExpression}\` — this call is UNCHECKED`
    );
    continue;
  }

  const matched = candidates.find(candidate => {
    const names = candidate.params.map(p => p.name);
    return call.args!.every(arg => names.includes(arg));
  });

  if (!matched) {
    const expected = candidates
      .map(c => `(${c.params.map(p => p.name).join(", ")})`)
      .join(" or ");
    problems.push(
      `${call.file}:${call.line} rpc("${call.fn}") args [${call.args.join(", ")}] ` +
        `match no SQL signature. SQL defines: ${expected}`
    );
    continue;
  }

  const missing = matched.params
    .filter(p => !p.hasDefault && !call.args!.includes(p.name))
    .map(p => p.name);

  if (missing.length) {
    problems.push(
      `${call.file}:${call.line} rpc("${call.fn}") omits required parameter(s) ` +
        `${missing.join(", ")} — SQL defines (${matched.params.map(p => p.name).join(", ")})`
    );
    continue;
  }

  console.log(
    `OK  ${call.file}:${call.line}\n` +
      `    rpc("${call.fn}", { ${call.args.join(", ")} })\n` +
      `    SQL: ${matched.file} (${matched.params.map(p => p.name + (p.hasDefault ? "?" : "")).join(", ")})`
  );
}

console.log();

if (problems.length) {
  console.error("RPC CONTRACT PROBLEMS:");
  for (const problem of problems) console.error(`  - ${problem}`);
  Deno.exit(1);
}

console.log(`RPC contract: ${tsCalls.length} call site(s) agree with the migrations.`);
